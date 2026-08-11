import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import type { NamedStrategy } from "../src/config/schema.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintConflictError,
  StrategyBlueprintDriftError,
  StrategyBlueprintIndeterminateError,
  StrategyBlueprintNotFoundError,
  StrategyBlueprintUnsafePathError,
  StrategyBlueprintValidationError,
} from "../src/strategies/catalog.js";
import { resolveStrategy } from "../src/strategies/resolve.js";

const sampleDefinition = {
  topology: { mode: "sequential" as const },
  maxParallel: 1,
  maxReworkAttempts: 4,
  maxAgentInvocations: 24,
  roleProfiles: { reviewer: "codex-planner" },
  approvalGates: ["plan", "final"] as Array<"plan" | "final">,
};

const alternateDefinition = {
  topology: { mode: "parallel-dag" as const },
  maxParallel: 3,
  roleProfiles: {},
  approvalGates: ["final"] as Array<"final">,
};

describe("strategy blueprint catalog", () => {
  it("persists serialized custom strategies and restores them after restart", async () => {
    const root = await fixtureConfig();
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root));

    await Promise.all([
      catalog.save("serial-review", {
        topology: { mode: "sequential" },
        maxParallel: 1,
        maxReworkAttempts: 4,
        maxAgentInvocations: 24,
        roleProfiles: { reviewer: "codex-planner" },
        approvalGates: ["plan", "final"],
      }),
      catalog.save("fast-lane", {
        topology: { mode: "parallel-dag" },
        maxParallel: 4,
        roleProfiles: {},
        approvalGates: ["final"],
      }),
    ]);

    expect(catalog.customNames()).toEqual(["fast-lane", "serial-review"]);
    expect(resolveStrategy(catalog.loaded.config, "serial-review")).toMatchObject({
      name: "serial-review",
      maxParallel: 1,
      maxReworkAttempts: 4,
      approvalGates: ["plan", "final"],
      topology: { mode: "sequential" },
    });
    const persisted = JSON.parse(await readFile(catalog.filePath, "utf8")) as {
      version: number;
      definitions: Record<string, unknown>;
    };
    expect(persisted.version).toBe(1);
    expect(Object.keys(persisted.definitions).sort()).toEqual(["fast-lane", "serial-review"]);

    const reopened = await StrategyBlueprintCatalog.open(await loadConfig(root));
    expect(reopened.source("serial-review")).toBe("custom");
    expect(resolveStrategy(reopened.loaded.config, "fast-lane").maxParallel).toBe(4);
    await reopened.delete("serial-review");
    expect(() => resolveStrategy(reopened.loaded.config, "serial-review")).toThrow(
      "Unknown strategy 'serial-review'",
    );
  });

  it("protects configured strategies and applies full role/profile validation", async () => {
    const root = await fixtureConfig();
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root));

    await expect(catalog.save("balanced", { roleProfiles: {} })).rejects.toBeInstanceOf(
      StrategyBlueprintConflictError,
    );
    await expect(catalog.delete("balanced")).rejects.toBeInstanceOf(StrategyBlueprintConflictError);
    expect(catalog.source("balanced")).toBe("config");
    expect(catalog.customDefinition("balanced")).toBeUndefined();
    expect(() => catalog.preflight("bad/name", { roleProfiles: {} })).toThrow(
      "Strategy name must be",
    );
    expect(() =>
      catalog.preflight("unsafe", {
        roleProfiles: { reviewer: "codex-worker" },
      }),
    ).toThrow("is not allowed for role 'reviewer'");
    const reserved = "auto-eval-0123456789abcdef01234567-1";
    expect(() => catalog.preflight(reserved, sampleDefinition)).toThrow(
      "reserved automatic evaluation format",
    );
    await expect(catalog.save(reserved, sampleDefinition)).rejects.toThrow(
      "reserved automatic evaluation format",
    );
    await catalog.saveAutomaticShadow(reserved, sampleDefinition);
    await expect(catalog.delete(reserved)).resolves.toBeUndefined();
    await expect(catalog.save("auto-eval-manual-1", sampleDefinition)).resolves.toBeDefined();
  });

  it("returns deeply immutable custom definition reads and never exposes configured strategies", async () => {
    const root = await fixtureConfig();
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root));
    await catalog.save("immutable-lane", sampleDefinition);

    const first = catalog.customDefinition("immutable-lane");
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first!.topology)).toBe(true);
    expect(Object.isFrozen(first!.roleProfiles)).toBe(true);
    expect(Object.isFrozen(first!.approvalGates)).toBe(true);

    expect(() => {
      (first as { maxParallel?: number }).maxParallel = 99;
    }).toThrow();
    expect(() => {
      (first!.roleProfiles as Record<string, string>).worker = "codex-worker";
    }).toThrow();
    expect(() => {
      (first!.approvalGates as string[]).push("plan");
    }).toThrow();

    const second = catalog.customDefinition("immutable-lane");
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(catalog.customDefinition("balanced")).toBeUndefined();
    expect(catalog.customDefinition("missing")).toBeUndefined();
  });

  it("supports expected-before conditional save/delete and rejects drift", async () => {
    const root = await fixtureConfig();
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root));

    await expect(
      catalog.save("conditional", sampleDefinition, { expectedBefore: sampleDefinition }),
    ).rejects.toBeInstanceOf(StrategyBlueprintDriftError);

    const created = await catalog.save("conditional", sampleDefinition, { expectedBefore: null });
    expect(created.name).toBe("conditional");
    const prior = catalog.customDefinition("conditional")!;

    await expect(
      catalog.save("conditional", alternateDefinition, { expectedBefore: null }),
    ).rejects.toBeInstanceOf(StrategyBlueprintDriftError);

    await expect(
      catalog.save("conditional", alternateDefinition, {
        expectedBefore: { ...sampleDefinition, maxParallel: 9 },
      }),
    ).rejects.toBeInstanceOf(StrategyBlueprintDriftError);

    const replaced = await catalog.save("conditional", alternateDefinition, {
      expectedBefore: prior,
    });
    expect(replaced.definition.maxParallel).toBe(3);
    expect(catalog.customDefinition("conditional")?.maxParallel).toBe(3);

    await expect(
      catalog.delete("conditional", { expectedBefore: prior }),
    ).rejects.toBeInstanceOf(StrategyBlueprintDriftError);

    await catalog.delete("conditional", {
      expectedBefore: catalog.customDefinition("conditional")!,
    });
    expect(catalog.customDefinition("conditional")).toBeUndefined();

    await expect(
      catalog.delete("conditional", { expectedBefore: alternateDefinition }),
    ).rejects.toBeInstanceOf(StrategyBlueprintDriftError);
    await expect(catalog.delete("conditional")).rejects.toBeInstanceOf(
      StrategyBlueprintNotFoundError,
    );

    // Unconditional save still works for legacy control-plane callers.
    await catalog.save("legacy-unconditional", sampleDefinition);
    expect(catalog.source("legacy-unconditional")).toBe("custom");
  });

  it("rejects stale instance writes instead of overwriting newer disk state", async () => {
    const root = await fixtureConfig();
    const loaded = await loadConfig(root);
    const first = await StrategyBlueprintCatalog.open(loaded);
    const stale = await StrategyBlueprintCatalog.open(await loadConfig(root));

    await first.save("first-writer", sampleDefinition, { expectedBefore: null });
    await expect(
      stale.save("stale-writer", alternateDefinition, { expectedBefore: null }),
    ).rejects.toBeInstanceOf(StrategyBlueprintDriftError);
    expect(stale.customNames()).toEqual([]);

    const reopened = await StrategyBlueprintCatalog.open(await loadConfig(root));
    expect(reopened.customNames()).toEqual(["first-writer"]);
    expect(reopened.customDefinition("stale-writer")).toBeUndefined();
  });

  it("rejects unsafe state directories and symlinked catalog storage", async () => {
    const escapeRoot = await mkdtemp(path.join(tmpdir(), "agent-team-strategy-escape-"));
    const root = await fixtureConfig({ stateDirectory: "../outside-state" });
    await expect(StrategyBlueprintCatalog.open(await loadConfig(root))).rejects.toBeInstanceOf(
      StrategyBlueprintUnsafePathError,
    );
    await rm(escapeRoot, { recursive: true, force: true });

    const symlinkRoot = await fixtureConfig();
    const loaded = await loadConfig(symlinkRoot);
    const stateDir = path.join(symlinkRoot, ".agent-team");
    await mkdir(stateDir, { recursive: true });
    const outside = await mkdtemp(path.join(tmpdir(), "agent-team-strategy-outside-"));
    const outsideCatalog = path.join(outside, "strategy-blueprints.json");
    await writeFile(outsideCatalog, `${JSON.stringify({ version: 1, definitions: {} })}\n`, "utf8");
    await symlink(outsideCatalog, path.join(stateDir, "strategy-blueprints.json"));
    await expect(StrategyBlueprintCatalog.open(loaded)).rejects.toBeInstanceOf(
      StrategyBlueprintUnsafePathError,
    );
    await rm(outside, { recursive: true, force: true });

    const linkedDirRoot = await fixtureConfig({ stateDirectory: "linked-state" });
    const outsideDir = await mkdtemp(path.join(tmpdir(), "agent-team-strategy-linkdir-"));
    await symlink(outsideDir, path.join(linkedDirRoot, "linked-state"));
    await expect(
      StrategyBlueprintCatalog.open(await loadConfig(linkedDirRoot)),
    ).rejects.toBeInstanceOf(StrategyBlueprintUnsafePathError);
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("writes temporary files with mode 0600 and fsyncs in open/write/file-sync/rename/directory-sync order", async () => {
    const root = await fixtureConfig();
    const stages: string[] = [];
    let temporaryPath: string | undefined;
    let temporaryMode: number | undefined;
    let renamed = false;

    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root), {
      io: {
        open: async (filePath, flags, mode) => {
          stages.push(`open:${String(flags)}:${mode === undefined ? "default" : mode.toString(8)}`);
          temporaryPath = String(filePath);
          const handle = await import("node:fs/promises").then((fs) =>
            fs.open(filePath, flags, mode),
          );
          const originalWriteFile = handle.writeFile.bind(handle);
          const originalSync = handle.sync.bind(handle);
          const originalClose = handle.close.bind(handle);
          handle.writeFile = (async (...args: Parameters<typeof handle.writeFile>) => {
            stages.push("write");
            return await originalWriteFile(...args);
          }) as typeof handle.writeFile;
          handle.sync = (async () => {
            stages.push("file-sync");
            if (temporaryPath) {
              temporaryMode = (await stat(temporaryPath)).mode & 0o777;
            }
            return await originalSync();
          }) as typeof handle.sync;
          handle.close = (async () => {
            stages.push("close");
            return await originalClose();
          }) as typeof handle.close;
          return handle;
        },
        rename: async (from, to) => {
          stages.push("rename");
          renamed = true;
          return await rename(from, to);
        },
        syncDirectory: async (directoryPath) => {
          stages.push(`directory-sync:${path.basename(directoryPath)}`);
          const handle = await import("node:fs/promises").then((fs) => fs.open(directoryPath, "r"));
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      },
    });

    await catalog.save("fsync-order", sampleDefinition);
    expect(renamed).toBe(true);
    expect(temporaryMode).toBe(0o600);
    expect(stages.filter((stage) => stage.startsWith("open:"))[0]).toMatch(/^open:wx:600$/);
    const core = stages.filter((stage) =>
      ["write", "file-sync", "rename"].includes(stage) ||
      stage.startsWith("open:") ||
      stage.startsWith("directory-sync:"),
    );
    expect(core).toEqual([
      "open:wx:600",
      "write",
      "file-sync",
      "rename",
      "directory-sync:.agent-team",
    ]);
    expect((await stat(catalog.filePath)).isFile()).toBe(true);
  });

  it.each(["open", "write", "file-sync", "rename"] as const)(
    "keeps memory and disk unchanged and leaves the queue usable when atomic stage %s fails",
    async (stage) => {
      const root = await fixtureConfig();
      let failStage: typeof stage | undefined;
      const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root), {
        io: {
          beforeAtomicStage: async (current) => {
            if (current === failStage) throw new Error(`injected ${stage} failure`);
          },
        },
      });
      await catalog.save("ok-lane", sampleDefinition);
      const diskBefore = await readFile(catalog.filePath, "utf8");
      const namesBefore = catalog.customNames();

      failStage = stage;
      await expect(catalog.save("fail-lane", alternateDefinition)).rejects.toBeInstanceOf(
        StrategyBlueprintValidationError,
      );
      failStage = undefined;

      expect(catalog.customNames()).toEqual(namesBefore);
      expect(catalog.customDefinition("fail-lane")).toBeUndefined();
      expect(await readFile(catalog.filePath, "utf8")).toBe(diskBefore);

      await catalog.save("recover-lane", alternateDefinition);
      expect(catalog.customNames()).toEqual(["ok-lane", "recover-lane"]);
      expect(catalog.customDefinition("recover-lane")?.maxParallel).toBe(3);
    },
  );

  it("fails closed after a post-rename directory fsync error and requires reopen", async () => {
    const root = await fixtureConfig();
    let failDirectorySync = false;
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root), {
      io: {
        beforeAtomicStage: async (stage) => {
          if (failDirectorySync && stage === "directory-sync") {
            throw new Error("injected directory fsync failure");
          }
        },
      },
    });
    await catalog.save("before-indeterminate", sampleDefinition);

    failDirectorySync = true;
    await expect(catalog.save("indeterminate-lane", alternateDefinition)).rejects.toBeInstanceOf(
      StrategyBlueprintIndeterminateError,
    );
    failDirectorySync = false;

    await expect(catalog.save("after-indeterminate", sampleDefinition)).rejects.toBeInstanceOf(
      StrategyBlueprintIndeterminateError,
    );
    await expect(catalog.delete("before-indeterminate")).rejects.toBeInstanceOf(
      StrategyBlueprintIndeterminateError,
    );

    // Disk may already contain the renamed document; reopen recovers a consistent view.
    const reopened = await StrategyBlueprintCatalog.open(await loadConfig(root));
    expect(reopened.customDefinition("indeterminate-lane")?.maxParallel).toBe(3);
    await reopened.save("post-reopen", sampleDefinition);
    expect(reopened.customNames()).toContain("post-reopen");
  });

  it("fails closed when rename replaces the primary file and then reports failure", async () => {
    const root = await fixtureConfig();
    let failAfterRename = false;
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root), {
      io: {
        rename: async (from, to) => {
          await rename(from, to);
          if (failAfterRename) throw new Error("rename reported failure after replacement");
        },
      },
    });
    await catalog.save("before-uncertain-rename", sampleDefinition);

    failAfterRename = true;
    await expect(
      catalog.save("uncertain-rename", alternateDefinition),
    ).rejects.toBeInstanceOf(StrategyBlueprintIndeterminateError);
    failAfterRename = false;
    expect(catalog.customDefinition("uncertain-rename")).toBeUndefined();
    await expect(catalog.save("must-reopen", sampleDefinition)).rejects.toBeInstanceOf(
      StrategyBlueprintIndeterminateError,
    );

    const reopened = await StrategyBlueprintCatalog.open(await loadConfig(root));
    expect(reopened.customDefinition("uncertain-rename")?.maxParallel).toBe(3);
  });

  it("cleans only positively identified catalog temporaries", async () => {
    const root = await fixtureConfig();
    const stateDirectory = path.join(root, ".agent-team");
    await mkdir(stateDirectory, { recursive: true });
    const unrelated = path.join(stateDirectory, "strategy-blueprints.json.user-backup.tmp");
    const owned = path.join(
      stateDirectory,
      "strategy-blueprints.json.123.00000000-0000-4000-8000-000000000000.tmp",
    );
    await writeFile(unrelated, "keep me\n", "utf8");
    await writeFile(owned, "orphan\n", "utf8");

    await StrategyBlueprintCatalog.open(await loadConfig(root));

    expect(await readFile(unrelated, "utf8")).toBe("keep me\n");
    await expect(readFile(owned, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent mutations through a failure-tolerant queue", async () => {
    const root = await fixtureConfig();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredSecond = false;
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root), {
      io: {
        beforeAtomicStage: async (stage) => {
          if (stage === "write" && !enteredSecond) {
            await firstGate;
          }
        },
      },
    });

    const first = catalog.save("queue-a", sampleDefinition);
    // Allow the first mutation to reach the write gate.
    await new Promise((resolve) => setTimeout(resolve, 20));
    enteredSecond = true;
    const second = catalog.save("queue-b", alternateDefinition);
    releaseFirst();
    await Promise.all([first, second]);
    expect(catalog.customNames()).toEqual(["queue-a", "queue-b"]);
  });
});

async function fixtureConfig(options: { stateDirectory?: string } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-strategy-catalog-"));
  const config = createDefaultConfig("fixture");
  if (options.stateDirectory) {
    config.project.stateDirectory = options.stateDirectory;
  }
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
  return root;
}
