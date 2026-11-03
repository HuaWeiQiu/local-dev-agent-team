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
import type { EvolutionApplicationFileIo } from "../src/evolution/application-shared.js";
import { EvolutionApplicationTargets } from "../src/evolution/application-target.js";
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

async function repository(): Promise<{ root: string; targets: EvolutionApplicationTargets }> {
  // macOS hands out /var/... which is itself a symlink into /private/var, so the fixture root
  // has to be canonical before a "no traversal" guard can pass on a healthy file.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-team-target-guard-")));
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await writeFile(path.join(root, promptPath), "original prompt\n", "utf8");
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

describe("prompt target guards", () => {
  it("refuses a prompt target that does not exist, and says evolution never creates one", async () => {
    const { targets } = await repository();
    await expect(targets.describePromptTarget("prompts/absent.md")).rejects.toMatchObject({
      code: "MATERIAL_MISSING",
      message:
        "Prompt target 'prompts/absent.md' does not exist; evolution never creates prompt files",
    });
  });

  it("refuses a prompt target that is a symlink", async () => {
    const { root, targets } = await repository();
    await symlink(path.join(root, promptPath), path.join(root, "prompts/link.md"));
    await expect(targets.describePromptTarget("prompts/link.md")).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: "Prompt target must be a regular non-symlink file: prompts/link.md",
    });
  });

  it("refuses a prompt target carrying special permission bits", async () => {
    const { root, targets } = await repository();
    await chmod(path.join(root, promptPath), 0o2644);
    await expect(targets.describePromptTarget(promptPath)).rejects.toMatchObject({
      code: "TARGET_DRIFTED",
      message: `Prompt target '${promptPath}' must not use special permission bits`,
    });
    await chmod(path.join(root, promptPath), 0o644);
  });

  it("refuses a prompt path whose parent directory is a symlink", async () => {
    const { root, targets } = await repository();
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
    const { root, targets } = await repository();
    const facts = await targets.describePromptTarget(promptPath);
    expect(facts).toMatchObject({ relativePath: promptPath, mode: 0o644 });
    expect(await readFile(facts.absolute, "utf8")).toBe("original prompt\n");
    expect(facts.absolute).toBe(path.join(root, promptPath));
  });
});
