import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintUnsafePathError,
  StrategyBlueprintValidationError,
} from "../src/strategies/catalog.js";

async function fixtureRoot(stateDirectory?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-catalog-open-"));
  const config = createDefaultConfig("fixture");
  if (stateDirectory !== undefined) config.project.stateDirectory = stateDirectory;
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
  return root;
}

describe("StrategyBlueprintCatalog.open refusals", () => {
  it("refuses a missing loaded config", async () => {
    await expect(
      StrategyBlueprintCatalog.open(undefined),
    ).rejects.toThrow("LoadedConfig is required");
  });

  it("refuses a config without a root", async () => {
    await expect(
      StrategyBlueprintCatalog.open({ config: {} }),
    ).rejects.toThrow("LoadedConfig.root is required");
  });

  it("refuses a config without a project config", async () => {
    await expect(
      StrategyBlueprintCatalog.open({ root: "/tmp", config: undefined }),
    ).rejects.toThrow("LoadedConfig.config is required");
  });

  it("names the root it could not resolve", async () => {
    const root = await fixtureRoot();
    const loaded = await loadConfig(root);

    await expect(
      StrategyBlueprintCatalog.open(loaded, {
        io: { realpath: async () => Promise.reject(new Error("boom")) },
      }),
    ).rejects.toThrow(`Unable to resolve repository root '${root}': boom`);
  });

  it("refuses a root that resolves to something other than a directory", async () => {
    const root = await fixtureRoot();
    const loaded = await loadConfig(root);

    await expect(
      StrategyBlueprintCatalog.open(loaded, {
        io: { lstat: async () => ({ isDirectory: () => false }) as never },
      }),
    ).rejects.toThrow("LoadedConfig.root must resolve to a directory");
  });

  it("keeps its error type for an unsafe state directory", async () => {
    const root = await fixtureRoot("../outside");
    const loaded = await loadConfig(root);

    const error = await StrategyBlueprintCatalog.open(loaded).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StrategyBlueprintUnsafePathError);
  });

  it("keeps the validation error type for a blank state directory", async () => {
    const root = await fixtureRoot("   ");
    const loaded = await loadConfig(root);

    const error = await StrategyBlueprintCatalog.open(loaded).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StrategyBlueprintValidationError);
  });
});

describe("StrategyBlueprintCatalog.open storage preparation order", () => {
  it("creates the directory, proves ownership, then sweeps orphans - in that order", async () => {
    const root = await fixtureRoot();
    const loaded = await loadConfig(root);
    const calls: string[] = [];
    const record = (name: string) => {
      calls.push(name);
    };

    await StrategyBlueprintCatalog.open(loaded, {
      io: {
        mkdir: (async (...args: Parameters<typeof import("node:fs/promises").mkdir>) => {
          record("mkdir");
          const fs = await import("node:fs/promises");
          return await fs.mkdir(...args);
        }) as never,
        realpath: (async (...args: Parameters<typeof import("node:fs/promises").realpath>) => {
          record("realpath");
          const fs = await import("node:fs/promises");
          return await fs.realpath(...args);
        }) as never,
        lstat: (async (...args: Parameters<typeof import("node:fs/promises").lstat>) => {
          record("lstat");
          const fs = await import("node:fs/promises");
          return await fs.lstat(...args);
        }) as never,
        readdir: (async (...args: Parameters<typeof import("node:fs/promises").readdir>) => {
          record("readdir");
          const fs = await import("node:fs/promises");
          return await fs.readdir(...args);
        }) as never,
      },
    });

    // The root is resolved first; then the three storage steps run in order:
    // mkdir (create) -> lstat (ownership proof) -> readdir (orphan sweep).
    const firstMkdir = calls.indexOf("mkdir");
    const proofLstat = calls.findIndex((call, index) => index > firstMkdir && call === "lstat");
    const sweep = calls.indexOf("readdir");
    expect(firstMkdir).toBeGreaterThan(0);
    expect(proofLstat).toBeGreaterThan(firstMkdir);
    expect(sweep).toBeGreaterThan(proofLstat);
  });
});
