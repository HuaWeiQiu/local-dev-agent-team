import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintConflictError,
} from "../src/strategies/catalog.js";
import { resolveStrategy } from "../src/strategies/resolve.js";

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
    expect(() => catalog.preflight("bad/name", { roleProfiles: {} })).toThrow(
      "Strategy name must be",
    );
    expect(() => catalog.preflight("unsafe", {
      roleProfiles: { reviewer: "codex-worker" },
    })).toThrow("is not allowed for role 'reviewer'");
  });
});

async function fixtureConfig(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-strategy-catalog-"));
  await writeFile(
    path.join(root, "agent-team.yaml"),
    stringifyYaml(createDefaultConfig("fixture")),
  );
  return root;
}
