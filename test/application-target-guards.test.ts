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
import { DurableEvolutionCatalog } from "../src/evolution/persistence.js";

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
): Promise<{
  root: string;
  targets: EvolutionApplicationTargets;
  strategies: StrategyBlueprintCatalog;
  catalog: DurableEvolutionCatalog;
  loaded: LoadedConfig;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-team-target-guard-")));
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await writeFile(path.join(root, promptPath), overrides.promptContent ?? Buffer.from("original prompt\n"));
  if (overrides.promptMode !== undefined) await chmod(path.join(root, promptPath), overrides.promptMode);
  const baseConfig = createDefaultConfig("guard");
  const loaded: LoadedConfig = {
    root,
    path: path.join(root, "agent-team.yaml"),
    config: {
      ...baseConfig,
      roles: {
        ...baseConfig.roles,
        worker: { ...baseConfig.roles.worker, promptFile: promptPath },
      },
    },
  };
  const strategies = await StrategyBlueprintCatalog.open(loaded);
  const targets = new EvolutionApplicationTargets({
    io: fileIo(),
    root,
    objectsDirectory: path.join(root, ".agent-team", "evolution", "objects", "sha256"),
    strategies,
    git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
    loaded,
  });
  return {
    root,
    targets,
    strategies,
    catalog: await DurableEvolutionCatalog.open(loaded),
    loaded,
  };
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
      targets.assertPromptWriteLanded(facts, sha256Bytes("some other bytes")),
    ).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      // The message names the file, not the path: it is built from the basename.
      message: `Prompt target digest mismatch after write for '${promptPath}'`,
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
      targets.assertPromptWriteLanded(facts, sha256Bytes(content)),
    ).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: `Prompt target permissions changed unexpectedly for '${promptPath}'`,
    });
  });

  it("accepts bytes that did land as written", async () => {
    const { targets } = await targetsFor();
    const facts = await targets.describePromptTarget(promptPath);
    await expect(
      targets.assertPromptWriteLanded(facts, sha256Bytes(Buffer.from("original prompt\n"))),
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

describe("prompt object store guards", () => {
  const digestOf = (content: Buffer) => sha256Bytes(content);

  it("refuses something that is not a digest at all", async () => {
    const { targets } = await targetsFor();
    await expect(targets.readPromptObject("not-a-digest")).rejects.toMatchObject({
      code: "MATERIAL_MISSING",
      message: "Invalid prompt object digest",
    });
  });

  it("reports a missing object by its digest", async () => {
    const { targets } = await targetsFor();
    const digest = digestOf(Buffer.from("never stored\n"));
    await expect(targets.readPromptObject(digest)).rejects.toMatchObject({
      code: "MATERIAL_MISSING",
      message: `Prompt object not found: ${digest}`,
    });
  });

  it("refuses an object that is a symlink", async () => {
    const { root, targets } = await targetsFor();
    const content = Buffer.from("stored prompt\n");
    const digest = digestOf(content);
    const objects = path.join(root, ".agent-team", "evolution", "objects", "sha256");
    await mkdir(objects, { recursive: true });
    const outside = path.join(root, "outside-object");
    await writeFile(outside, content);
    await symlink(outside, path.join(objects, digest));
    await expect(targets.readPromptObject(digest)).rejects.toMatchObject({
      code: "MATERIAL_MISSING",
      message: `Prompt object must be a regular non-symlink file: ${digest}`,
    });
  });

  it("refuses an object whose permissions are not 0600", async () => {
    const { root, targets } = await targetsFor();
    const content = Buffer.from("stored prompt\n");
    const digest = digestOf(content);
    const objects = path.join(root, ".agent-team", "evolution", "objects", "sha256");
    await mkdir(objects, { recursive: true });
    await writeFile(path.join(objects, digest), content);
    await chmod(path.join(objects, digest), 0o644);
    await expect(targets.readPromptObject(digest)).rejects.toMatchObject({
      code: "MATERIAL_MISSING",
      message: `Prompt object permissions must be 0600: ${digest}`,
    });
  });

  it("refuses an object whose bytes no longer hash to its name", async () => {
    const { root, targets } = await targetsFor();
    const content = Buffer.from("stored prompt\n");
    const digest = digestOf(content);
    const objects = path.join(root, ".agent-team", "evolution", "objects", "sha256");
    await mkdir(objects, { recursive: true });
    await writeFile(path.join(objects, digest), content);
    await chmod(path.join(objects, digest), 0o600);
    await writeFile(path.join(objects, digest), Buffer.from("tampered\n"));
    await expect(targets.readPromptObject(digest)).rejects.toMatchObject({
      code: "MATERIAL_MISSING",
      message: `Corrupted prompt object: ${digest}`,
    });
  });

  it("returns the bytes of an object it stored itself", async () => {
    const { targets } = await targetsFor();
    const content = Buffer.from("stored prompt\n");
    await targets.ingestPromptMaterial(digestOf(content), content);
    await expect(targets.readPromptObject(digestOf(content))).resolves.toEqual(content);
  });
});

describe("strategy target failure mapping", () => {
  const definition = (maxParallel: number) => ({
    topology: { mode: "parallel-dag" as const },
    maxParallel,
    maxReworkAttempts: 3,
    executionTimeoutSeconds: 3_600,
    maxAgentInvocations: 42,
    maxProcessOutputBytes: 65_536,
    maxArtifactBytes: 1_048_576,
    roleProfiles: { worker: "codex-worker" },
    approvalGates: ["plan", "final"] as const,
    approvalTimeoutSeconds: 600,
  });

  /** A real proposal for a strategy candidate, so the target layer sees what it really sees. */
  async function strategyProposal(name: string) {
    const world = await targetsFor();
    await world.catalog.propose({
      id: `${name}-proposal`,
      createdAt: new Date().toISOString(),
      policy: {
        version: 1,
        capabilities: {
          automaticExecution: false,
          automaticPromotion: false,
          networkPublication: false,
          secretStorage: false,
        },
        allowedPromptPaths: [],
      },
      candidate: { kind: "strategy-blueprint", name, definition: definition(4) },
    });
    const proposal = world.catalog.getProposal(`${name}-proposal`);
    if (!proposal) throw new Error("proposal disappeared");
    return { ...world, proposal };
  }

  it("maps a definition that moved underneath the apply to TARGET_DRIFTED", async () => {
    const { targets, strategies, proposal } = await strategyProposal("drifted");
    await strategies.save("drifted", definition(2), { expectedBefore: null });
    await strategies.save("drifted", definition(3), { expectedBefore: definition(2) });
    await expect(
      targets.applyStrategyTarget(
        proposal,
        { kind: "strategy-blueprint", identity: "drifted", digest: null, present: true, strategyDefinition: definition(2) },
        { kind: "strategy-blueprint", identity: "drifted", digest: null, present: true, strategyDefinition: definition(5) },
        "apply",
      ),
    ).rejects.toMatchObject({ code: "TARGET_DRIFTED" });
  });

  it("maps a save that expected absence but found a definition to TARGET_DRIFTED", async () => {
    const { targets, strategies, proposal } = await strategyProposal("conflicting");
    await strategies.save("conflicting", definition(2), { expectedBefore: null });
    await expect(
      targets.applyStrategyTarget(
        proposal,
        { kind: "strategy-blueprint", identity: "conflicting", digest: null, present: false },
        { kind: "strategy-blueprint", identity: "conflicting", digest: null, present: true, strategyDefinition: definition(6) },
        "apply",
      ),
    ).rejects.toMatchObject({
      // The catalog calls this drift, not conflict: the write expected absence and found a
      // definition, which is a disagreement about the current state, not a policy refusal.
      code: "TARGET_DRIFTED",
      message: "Strategy blueprint 'conflicting' drifted: expected absence before write",
    });
  });

  it("refuses to modify a strategy the project configures", async () => {
    const { targets, loaded } = await targetsFor();
    const configured = Object.keys(loaded.config.strategies?.definitions ?? {})[0];
    expect(configured).toBeDefined();
    const { catalog } = await targetsFor();
    await catalog.propose({
      id: "configured-proposal",
      createdAt: new Date().toISOString(),
      policy: {
        version: 1,
        capabilities: {
          automaticExecution: false,
          automaticPromotion: false,
          networkPublication: false,
          secretStorage: false,
        },
        allowedPromptPaths: [],
      },
      candidate: { kind: "strategy-blueprint", name: configured!, definition: definition(4) },
    });
    const proposal = catalog.getProposal("configured-proposal");
    if (!proposal) throw new Error("proposal disappeared");
    await expect(
      targets.applyStrategyTarget(
        proposal,
        { kind: "strategy-blueprint", identity: configured!, digest: null, present: false },
        { kind: "strategy-blueprint", identity: configured!, digest: null, present: true, strategyDefinition: definition(4) },
        "apply",
      ),
    ).rejects.toThrow(/cannot be modified by evolution application/);
  });
});

describe("prompt candidate guard", () => {
  async function propose(
    candidate: Record<string, unknown>,
    id: string,
    allowedPromptPaths: string[] = [],
  ) {
    const world = await targetsFor();
    await world.catalog.propose({
      id,
      createdAt: new Date().toISOString(),
      policy: {
        version: 1,
        capabilities: {
          automaticExecution: false,
          automaticPromotion: false,
          networkPublication: false,
          secretStorage: false,
        },
        allowedPromptPaths,
      },
      candidate,
    });
    const proposal = world.catalog.getProposal(id);
    if (!proposal) throw new Error("proposal disappeared");
    return { ...world, proposal };
  }

  it("refuses a candidate that is not a role prompt", async () => {
    const { targets, proposal } = await propose(
      {
        kind: "strategy-blueprint",
        name: "not-a-prompt",
        definition: {
          topology: { mode: "parallel-dag" },
          maxParallel: 4,
          maxReworkAttempts: 3,
          executionTimeoutSeconds: 3_600,
          maxAgentInvocations: 42,
          maxProcessOutputBytes: 65_536,
          maxArtifactBytes: 1_048_576,
          roleProfiles: { worker: "codex-worker" },
          approvalGates: ["plan", "final"],
          approvalTimeoutSeconds: 600,
        },
      },
      "not-a-prompt-proposal",
    );
    expect(() => targets.assertPromptCandidate(proposal)).toThrow(
      "Not a role-prompt candidate",
    );
  });

  it("refuses a prompt path no role configures", async () => {
    // The proposal must be made against a config that does allow the path — the catalog
    // refuses anything else. The layer under test is then built with a config that no longer
    // names that role: the state a config edit between propose and apply produces.
    const { root, proposal } = await propose(
      { kind: "role-prompt", path: promptPath, contentDigest: sha256Bytes("x") },
      "stranger-proposal",
      [promptPath],
    );
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
    expect(() => targets.assertPromptCandidate(proposal)).toThrow(
      `Prompt path '${promptPath}' is not a configured role promptFile`,
    );
  });

  it("returns the path of a prompt the project does configure", async () => {
    const { targets, proposal } = await propose(
      { kind: "role-prompt", path: promptPath, contentDigest: sha256Bytes("x") },
      "configured-prompt-proposal",
      [promptPath],
    );
    expect(targets.assertPromptCandidate(proposal)).toBe(promptPath);
  });
});

describe("strategy definition validation", () => {
  it("maps a definition the catalog rejects to POLICY_DENIED", async () => {
    const world = await targetsFor();
    await world.catalog.propose({
      id: "invalid-definition",
      createdAt: new Date().toISOString(),
      policy: {
        version: 1,
        capabilities: {
          automaticExecution: false,
          automaticPromotion: false,
          networkPublication: false,
          secretStorage: false,
        },
        allowedPromptPaths: [],
      },
      candidate: {
        kind: "strategy-blueprint",
        name: "invalid-definition",
        definition: {
          topology: { mode: "parallel-dag" },
          maxParallel: 4,
          maxReworkAttempts: 3,
          executionTimeoutSeconds: 3_600,
          maxAgentInvocations: 42,
          maxProcessOutputBytes: 65_536,
          maxArtifactBytes: 1_048_576,
          roleProfiles: { worker: "codex-worker" },
          approvalGates: ["plan", "final"],
          approvalTimeoutSeconds: 600,
        },
      },
    });
    const proposal = world.catalog.getProposal("invalid-definition");
    if (!proposal) throw new Error("proposal disappeared");
    // The catalog validates on save; a definition that breaks the schema is refused there,
    // which the target layer must surface as POLICY_DENIED rather than as a crash.
    await expect(
      world.targets.applyStrategyTarget(
        proposal,
        { kind: "strategy-blueprint", identity: "invalid-definition", digest: null, present: false },
        {
          kind: "strategy-blueprint",
          identity: "invalid-definition",
          digest: null,
          present: true,
          // @ts-expect-error: deliberately impossible (negative parallel width). The catalog
          // validates on save, and the target layer must surface that as POLICY_DENIED.
          strategyDefinition: { ...proposal.candidate.definition, maxParallel: -1 },
        },
        "apply",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
});

describe("object idempotency check", () => {
  async function withObject(content: Buffer) {
    const world = await targetsFor();
    const objects = path.join(world.root, ".agent-team", "evolution", "objects", "sha256");
    await mkdir(objects, { recursive: true });
    const digest = sha256Bytes(content);
    const objectPath = path.join(objects, digest);
    return { ...world, objects, digest, objectPath };
  }

  it("says the object is absent when there is nothing there", async () => {
    const { targets, objectPath, digest } = await withObject(Buffer.from("missing\n"));
    await expect(targets.objectAlreadyStored(objectPath, digest)).resolves.toBe(false);
  });

  it("says the object is stored when it is intact", async () => {
    const content = Buffer.from("stored\n");
    const { targets, objectPath, digest } = await withObject(content);
    await writeFile(objectPath, content);
    await chmod(objectPath, 0o600);
    await expect(targets.objectAlreadyStored(objectPath, digest)).resolves.toBe(true);
  });

  it("refuses a stored object that is a symlink", async () => {
    const content = Buffer.from("stored\n");
    const { root, targets, objectPath, digest } = await withObject(content);
    const outside = path.join(root, "elsewhere-object");
    await writeFile(outside, content);
    await symlink(outside, objectPath);
    await expect(targets.objectAlreadyStored(objectPath, digest)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: `Prompt object path is not a regular file: ${objectPath}`,
    });
  });

  it("refuses a stored object with the wrong permissions", async () => {
    const content = Buffer.from("stored\n");
    const { targets, objectPath, digest } = await withObject(content);
    await writeFile(objectPath, content);
    await chmod(objectPath, 0o644);
    await expect(targets.objectAlreadyStored(objectPath, digest)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: `Prompt object permissions must be 0600: ${digest}`,
    });
  });

  it("refuses a stored object whose bytes no longer match the digest", async () => {
    const content = Buffer.from("stored\n");
    const { targets, objectPath, digest } = await withObject(content);
    await writeFile(objectPath, Buffer.from("tampered\n"));
    await chmod(objectPath, 0o600);
    await expect(targets.objectAlreadyStored(objectPath, digest)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: `Corrupted prompt object at ${digest}`,
    });
  });
});
