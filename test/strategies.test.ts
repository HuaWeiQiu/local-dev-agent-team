import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { resolveStrategy } from "../src/strategies/resolve.js";

describe("strategy resolution", () => {
  it("resolves the configured default and inherits legacy limits", () => {
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.balanced = { roleProfiles: {} };

    expect(resolveStrategy(config)).toEqual({
      name: "balanced",
      maxParallel: 2,
      maxReworkAttempts: 2,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
      swarmMaxConcurrency: 2,
      explore: {
        enabled: false,
        maxInjectedChars: 4_000,
        failOpen: true,
      },
      topology: expect.objectContaining({
        version: 1,
        mode: "parallel-dag",
      }),
    });
  });

  it("resolves an explicitly requested strategy", () => {
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.strict = {
      maxParallel: 1,
      maxReworkAttempts: 4,
      roleProfiles: { reviewer: "codex-planner" },
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
    };

    expect(resolveStrategy(config, "strict")).toMatchObject({
      name: "strict",
      maxParallel: 1,
      maxReworkAttempts: 4,
      roleProfiles: { reviewer: "codex-planner" },
    });
  });

  it("compiles sequential execution and optional plan approval", () => {
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.strict = {
      topology: { mode: "sequential" },
      maxParallel: 1,
      roleProfiles: {},
      approvalGates: ["plan", "final"],
    };

    const resolved = resolveStrategy(config, "strict");

    expect(resolved.maxParallel).toBe(1);
    expect(resolved.topology.mode).toBe("sequential");
    expect(resolved.topology.stages.map((stage) => stage.id)).toEqual([
      "intake",
      "architecture",
      "plan-approval",
      "task-execution",
      "integration-quality",
      "final-decision",
      "final-approval",
      "publication",
    ]);
    expect(resolved.topology.edges).toHaveLength(resolved.topology.stages.length - 1);
    expect(resolved.topology.stages.find((stage) => stage.id === "task-execution")).toMatchObject({
      label: "串行执行",
      roles: ["worker", "reviewer", "tester"],
    });
  });

  it("enables explore stage and caps swarm concurrency", () => {
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.balanced = {
      maxParallel: 4,
      roleProfiles: {},
      taskMorphology: {
        explore: { enabled: true, maxInjectedChars: 2_000, failOpen: true },
        implement: { role: "worker", swarm: { maxConcurrency: 2 } },
      },
    };
    const resolved = resolveStrategy(config, "balanced");
    expect(resolved.swarmMaxConcurrency).toBe(2);
    expect(resolved.explore.enabled).toBe(true);
    expect(resolved.topology.stages.map((stage) => stage.id)).toContain("explore");
  });

  it("rejects an unknown requested strategy", () => {
    expect(() => resolveStrategy(createDefaultConfig("fixture"), "missing")).toThrow(
      "Unknown strategy 'missing'",
    );
  });
});
