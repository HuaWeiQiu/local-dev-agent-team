import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { LoadedConfig } from "../src/config/load.js";
import {
  EVOLUTION_PROMPT_MATERIAL_MAX_BYTES,
  sha256Bytes,
  type EvolutionApplicationFileIo,
  type TargetDigestState,
} from "../src/evolution/application-shared.js";
import {
  EvolutionApplicationTargets,
  cleanOrphanTemps,
} from "../src/evolution/application-target.js";
import { siblingTempName } from "../src/evolution/temp-names.js";
import { GitManager } from "../src/git/manager.js";
import { StrategyBlueprintCatalog } from "../src/strategies/catalog.js";

/**
 * These cases drive the **target layer directly**.
 *
 * The coordinator refuses most of these worlds at preview time, so through the public API the
 * arms are unreachable. They are still this layer's own contract: it is independently
 * constructible, another caller could reach it, and the coordinator's check must not be the
 * only one. See "four kinds of unreachable" in docs/ub-quality-gates.zh-CN.md before deleting
 * anything here — that section is why these tests exist.
 */

const promptPath = "prompts/worker.md";

/** The io these guards actually use; the rest is node's own implementation. */
function fileIo(): EvolutionApplicationFileIo {
  return {
    mkdir,
    lstat,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    unlink,
    open,
    writeFile,
    chmod,
    syncDirectory: async () => undefined,
  };
}

/**
 * A target layer over a fresh repository. **The fixture root is always canonicalised**: macOS
 * hands out `/var/...`, which is itself a symlink into `/private/var`, so a "does not traverse
 * links" guard would reject a perfectly healthy file. Doing it here means no individual case
 * has to know about it — the pit is a property of the factory, not a responsibility of each test.
 */
async function targetsFor(
  overrides: Partial<{ promptContent: Buffer; promptMode: number }> = {},
): Promise<{ root: string; targets: EvolutionApplicationTargets }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-team-target-guard-")));
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await writeFile(path.join(root, promptPath), overrides.promptContent ?? Buffer.from("original prompt\n"));
  if (overrides.promptMode !== undefined) await chmod(path.join(root, promptPath), overrides.promptMode);
  const loaded: LoadedConfig = {
    root,
    path: path.join(root, "agent-team.yaml"),
    config: createDefaultConfig("guard"),
  };
  const targets = new EvolutionApplicationTargets({
    io: fileIo(),
    root,
    objectsDirectory: path.join(root, ".agent-team", "evolution", "objects", "sha256"),
    strategies: await StrategyBlueprintCatalog.open(loaded),
    git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
    loaded,
  });
  return { root, targets };
}

/** What a preview would have recorded for the file as it stands. */
function previewOf(content: Buffer, mode: number): TargetDigestState {
  return {
    kind: "role-prompt",
    identity: promptPath,
    digest: sha256Bytes(content),
    present: true,
    mode,
  };
}

describe("prompt target guards", () => {
  it("refuses a prompt target that does not exist, and says evolution never creates one", async () => {
    const { targets } = await targetsFor();
    await expect(targets.describePromptTarget("prompts/absent.md")).rejects.toMatchObject({
      code: "MATERIAL_MISSING",
      message:
        "Prompt target 'prompts/absent.md' does not exist; evolution never creates prompt files",
    });
  });

  it("refuses a prompt target that is a symlink", async () => {
    const { root, targets } = await targetsFor();
    await symlink(path.join(root, promptPath), path.join(root, "prompts/link.md"));
    await expect(targets.describePromptTarget("prompts/link.md")).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: "Prompt target must be a regular non-symlink file: prompts/link.md",
    });
  });

  it("refuses a prompt target carrying special permission bits", async () => {
    const { targets } = await targetsFor({ promptMode: 0o2644 });
    await expect(targets.describePromptTarget(promptPath)).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: `Prompt target '${promptPath}' must not use special permission bits`,
    });
  });

  it("refuses a prompt path whose parent directory is a symlink", async () => {
    const { root, targets } = await targetsFor();
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "worker.md"), "original prompt\n", "utf8");
    await symlink(elsewhere, path.join(root, "linked-prompts"));
    await expect(targets.describePromptTarget("linked-prompts/worker.md")).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: "Prompt target 'linked-prompts/worker.md' must not traverse symbolic links",
    });
  });

  it("returns the facts of a target that passes every guard", async () => {
    const { root, targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    expect(facts).toMatchObject({ relativePath: promptPath, mode: 0o644 });
    expect(await readFile(facts.absolute, "utf8")).toBe("original prompt\n");
    expect(facts.absolute).toBe(path.join(root, promptPath));
  });
});

describe("prompt target concurrency guards", () => {
  it("refuses when the bytes on disk are not the bytes the preview approved", async () => {
    const { targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    const stalePreview = { ...previewOf(Buffer.from("something else\n"), facts.mode) };
    await expect(
      targets.assertPromptTargetUnchanged(facts.absolute, facts, stalePreview),
    ).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: `Prompt target '${promptPath}' changed after preview (content)`,
    });
  });

  it("refuses when the permissions changed since the preview", async () => {
    const { targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    const previewWithOtherMode = previewOf(Buffer.from("original prompt\n"), 0o600);
    await expect(
      targets.assertPromptTargetUnchanged(facts.absolute, facts, previewWithOtherMode),
    ).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: `Prompt target '${promptPath}' changed after preview (mode)`,
    });
  });

  it("refuses a target whose bytes are not valid UTF-8", async () => {
    const invalid = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const { targets } = await targetsFor({ promptContent: invalid });
    const facts = await targets.describePromptTarget(promptPath);
    await expect(
      targets.assertPromptTargetUnchanged(facts.absolute, facts, previewOf(invalid, facts.mode)),
    ).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: `Prompt target '${promptPath}' is not valid UTF-8`,
    });
  });

  it("refuses a target larger than the material limit", async () => {
    const oversized = Buffer.alloc(EVOLUTION_PROMPT_MATERIAL_MAX_BYTES + 1, 0x61);
    const { targets } = await targetsFor({ promptContent: oversized });
    const facts = await targets.describePromptTarget(promptPath);
    await expect(
      targets.assertPromptTargetUnchanged(facts.absolute, facts, previewOf(oversized, facts.mode)),
    ).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: `Prompt target '${promptPath}' exceeds material size limit`,
    });
  });

  it("returns the current bytes when the preview still describes them", async () => {
    const content = Buffer.from("original prompt\n");
    const { targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    await expect(
      targets.assertPromptTargetUnchanged(facts.absolute, facts, previewOf(content, facts.mode)),
    ).resolves.toEqual(content);
  });
});

describe("prompt write verification", () => {
  it("reports recovery when the bytes on disk are not the bytes that were written", async () => {
    const { root, targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    // A digest the file cannot possibly have: the write "landed" but not as asked.
    await expect(
      targets.assertPromptWriteLanded(facts.absolute, sha256Bytes("some other bytes"), facts.mode),
    ).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      // The message names the file, not the path: it is built from the basename.
      message: "Prompt target digest mismatch after write for 'worker.md'",
    });
    void root;
  });

  it("reports recovery when the target turned into a symlink during the write", async () => {
    const { root, targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    const outside = path.join(root, "outside.md");
    const content = Buffer.from("original prompt\n");
    await writeFile(outside, content);
    await rm(path.join(root, promptPath));
    await symlink(outside, path.join(root, promptPath));
    await expect(
      targets.assertPromptWriteLanded(facts.absolute, sha256Bytes(content), facts.mode),
    ).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: "Prompt target permissions changed unexpectedly for 'worker.md'",
    });
  });

  it("accepts bytes that did land as written", async () => {
    const { targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    await expect(
      targets.assertPromptWriteLanded(
        facts.absolute,
        sha256Bytes(Buffer.from("original prompt\n")),
        facts.mode,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("orphan temp cleanup", () => {
  it("removes only the temp names that belong to the file, and never follows a link", async () => {
    const { root } = await targetsFor();
    const directory = path.join(root, "prompts");
    const matching = siblingTempName(path.join(directory, "worker.md"));
    const unrelated = path.join(directory, "notes.md");
    const outside = path.join(root, "keep-me.md");
    const linked = siblingTempName(path.join(directory, "worker.md"));
    await writeFile(matching, "left behind\n");
    await writeFile(unrelated, "notes\n");
    await writeFile(outside, "must survive\n");
    await symlink(outside, linked);

    const io = fileIo();
    await cleanOrphanTemps(io, directory, "worker.md");
    await expect(readFile(matching, "utf8")).rejects.toThrow();
    expect(await readFile(unrelated, "utf8")).toBe("notes\n");
    // The symlink is not a file the cleaner may delete, and its target must be untouched.
    expect(await readFile(outside, "utf8")).toBe("must survive\n");
    expect(await lstat(linked)).toMatchObject({});
  });

  it("does nothing when the directory does not exist", async () => {
    const { root } = await targetsFor();
    await expect(
      cleanOrphanTemps(fileIo(), path.join(root, "nowhere"), "worker.md"),
    ).resolves.toBeUndefined();
  });
});
