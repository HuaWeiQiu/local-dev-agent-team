import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig, type LoadedConfig } from "../src/config/load.js";
import { configSchema, type NamedStrategy } from "../src/config/schema.js";
import {
  aggregateRunOutcomes,
  automaticCandidateImproved,
  automaticRunEvidenceItems,
  projectRunOutcome,
} from "../src/evolution/automation.js";
import { EvolutionApplicationCoordinator } from "../src/evolution/application.js";
import { DurableEvolutionCatalog } from "../src/evolution/persistence.js";
import { SqliteEventStore } from "../src/events/store.js";
import { GitManager } from "../src/git/manager.js";
import { runProcess } from "../src/process/run.js";
import { AutomaticEvolutionController } from "../src/server/evolution-automation.js";
import { RunSupervisor, type SupervisorDependencies } from "../src/server/supervisor.js";
import type { RunState } from "../src/state/types.js";
import { StrategyBlueprintCatalog } from "../src/strategies/catalog.js";
import { resolveStrategy } from "../src/strategies/resolve.js";

const candidateDefinition: NamedStrategy = {
  topology: { mode: "sequential" },
  maxParallel: 1,
  maxReworkAttempts: 1,
  maxAgentInvocations: 48,
  roleProfiles: {},
  approvalGates: ["final"],
};

describe("automatic evolution scoring", () => {
  it("uses persisted deterministic outcomes and the worst repeated score", () => {
    const strong = projectRunOutcome(evaluationState("strong", "balanced", 4, true));
    const weak = projectRunOutcome(evaluationState("weak", "balanced", 10, true));
    const failed = projectRunOutcome(evaluationState("failed", "balanced", 1, false));
    const aggregate = aggregateRunOutcomes([strong, weak]);

    expect(strong.score).toBeGreaterThan(weak.score);
    expect(aggregate).toMatchObject({ passed: true, score: weak.score, runIds: ["strong", "weak"] });
    expect(automaticCandidateImproved(aggregate, aggregateRunOutcomes([failed]), 1)).toBe(false);
    const evidence = automaticRunEvidenceItems(aggregate, aggregateRunOutcomes([strong]), 1);
    expect(evidence.map((item) => item.id)).toContain("automatic-incumbent-run-1");
    expect(evidence.find((item) => item.id === "automatic-incumbent-run-1")?.summary)
      .toContain("run=strong");
    expect(evidence.at(-1))
      .toMatchObject({ id: "automatic-incumbent-comparison-v1", status: "pass" });
  });

  it("fails closed when a blocked evaluation retains otherwise passing fields", () => {
    const state = evaluationState("blocked-residue", "balanced", 2, true);
    state.status = "blocked";

    expect(projectRunOutcome(state)).toMatchObject({ passed: false, status: "blocked" });
  });
});

describe("automatic evolution configuration", () => {
  it("enforces explicit start, bounded cycles, and a read-only proposer only when enabled", async () => {
    const disabled = createDefaultConfig("disabled-compatible");
    disabled.evolution.automatic.proposerRole = "missing-while-disabled";
    disabled.evolution.automatic.targetStrategy = "balanced";
    expect(configSchema.safeParse(disabled).success).toBe(true);

    const enabled = createAutomaticConfig("enabled-bounds");
    (enabled.evolution.automatic as { autoStart: boolean }).autoStart = true;
    expect(configSchema.safeParse(enabled).success).toBe(false);

    const tooMany = createAutomaticConfig("too-many-cycles");
    tooMany.evolution.automatic.maxCycles = 11;
    expect(configSchema.safeParse(tooMany).success).toBe(false);

    const noImprovement = createAutomaticConfig("invalid-no-improvement");
    noImprovement.evolution.automatic.maxCycles = 2;
    noImprovement.evolution.automatic.maxConsecutiveNoImprovement = 3;
    expect(configSchema.safeParse(noImprovement).success).toBe(false);

    const writable = createAutomaticConfig("writable-proposer");
    writable.roles.orchestrator!.allowedProfiles.push("codex-worker");
    writable.evolution.automatic.proposerProfile = "codex-worker";
    expect(configSchema.safeParse(writable).error?.issues.map((issue) => issue.message))
      .toContain("Automatic evolution proposer must use a read-only profile");

    const writableFallback = createAutomaticConfig("writable-proposer-fallback");
    writableFallback.roles.orchestrator!.fallbackProfiles = ["codex-worker"];
    expect(configSchema.safeParse(writableFallback).error?.issues.map((issue) => issue.message))
      .toContain("Automatic evolution proposer fallback 'codex-worker' must be read-only");

    const noQualityCommands = createAutomaticConfig("missing-deterministic-gate");
    noQualityCommands.quality.commands = [];
    expect(configSchema.safeParse(noQualityCommands).error?.issues.map((issue) => issue.message))
      .toContain("Enabled automatic evolution requires at least one deterministic quality command");

    const unknownAutomaticKey = createAutomaticConfig("strict-automatic-config");
    (unknownAutomaticKey.evolution.automatic as unknown as Record<string, unknown>).maxCycle = 3;
    expect(configSchema.safeParse(unknownAutomaticKey).success).toBe(false);

    const collision = createAutomaticConfig("configured-target-collision");
    collision.evolution.automatic.targetStrategy = "balanced";
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-auto-config-"));
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(collision), "utf8");
    await expect(loadConfig(root)).rejects.toThrow(
      "Automatic evolution target cannot replace a configured strategy",
    );
  });
});

describe("automatic evolution controller", () => {
  it("promotes an improved isolated candidate and makes it the runtime default", async () => {
    const harness = await createHarness((strategy) => strategy.startsWith("auto-eval-") ? 2 : 10);
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
      {
        createSessionId: () => "improved-session",
        proposeCandidate: async () => ({
          rationale: "Reduce avoidable orchestration work while retaining all gates",
          definition: candidateDefinition,
        }),
      },
    );

    controller.start(1, "improved-command", "session:alice");
    const snapshot = await controller.wait();
    const proposalId = snapshot.cycles[0]!.proposalId;

    expect(snapshot.error).toBeNull();
    expect(snapshot).toMatchObject({
      status: "completed",
      completedCycles: 1,
      consecutiveNoImprovement: 0,
      incumbentStrategy: "auto-evolved",
      cycles: [{ improved: true, decision: "promoted" }],
    });
    expect(harness.strategies.customDefinition("auto-evolved")).toEqual(candidateDefinition);
    expect(harness.loaded.config.strategies?.default).toBe("auto-evolved");
    expect(harness.strategies.automaticShadowNames()).toEqual([]);

    const proposal = harness.coordinator.readProposal(proposalId);
    expect(proposal).toMatchObject({
      status: "promoted",
      evaluation: { source: "server-automatic-run-evaluation-v1", result: { passed: true } },
    });
    expect((await harness.coordinator.readControlSnapshot()).catalog.auditRecords)
      .toContainEqual(expect.objectContaining({
        kind: "promotion",
        proposalId,
        actor: "session:alice",
      }));
    expect(controller.start(1, "improved-command", "session:alice"))
      .toMatchObject({ status: "completed", sessionId: "improved-session" });
    expect(() => controller.start(2, "improved-command", "session:alice"))
      .toThrow("already used for another request");
    const replacement = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
    );
    expect(() => replacement.start(1, "improved-command", "session:alice"))
      .toThrow("already accepted by session 'improved-session'");
    const ordinary = harness.supervisor.start({ goal: "Use the winner", profileOverrides: {} });
    await expect(harness.supervisor.wait(ordinary.runId)).resolves.toMatchObject({
      strategy: { name: "auto-evolved" },
    });
    const root = harness.root;
    await closeHarness(harness);

    const reopened = await reopenHarness(root);
    const restoredController = new AutomaticEvolutionController(
      reopened.loaded,
      reopened.coordinator,
      reopened.strategies,
      reopened.supervisor,
    );
    await restoredController.restoreRuntimeDefault();
    expect(reopened.loaded.config.strategies?.default).toBe("auto-evolved");
    expect(reopened.coordinator.readProposal(proposalId)).toMatchObject({
      status: "promoted",
      evaluation: { source: "server-automatic-run-evaluation-v1" },
    });
    expect(() => restoredController.start(1, "improved-command", "session:alice"))
      .toThrow("already accepted by session 'improved-session'");
    await closeHarness(reopened);
  });

  it("stops before the hard limit after consecutive candidates do not improve", async () => {
    let proposals = 0;
    const harness = await createHarness(() => 8, { maxCycles: 3, noImprovement: 2 });
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
      {
        createSessionId: () => "no-improvement-session",
        proposeCandidate: async () => {
          proposals += 1;
          return { rationale: `Conservative candidate ${proposals}`, definition: candidateDefinition };
        },
      },
    );

    controller.start(3);
    const snapshot = await controller.wait();

    expect(snapshot.error).toBeNull();
    expect(snapshot).toMatchObject({
      status: "completed",
      completedCycles: 2,
      consecutiveNoImprovement: 2,
      cycles: [
        { improved: false, decision: "rejected" },
        { improved: false, decision: "rejected" },
      ],
    });
    expect(snapshot.stopReason).toContain("2 consecutive cycles");
    expect(proposals).toBe(2);
    expect(harness.strategies.customDefinition("auto-evolved")).toBeUndefined();
    await closeHarness(harness);
  });

  it("fails closed instead of replacing a manually managed target strategy", async () => {
    const harness = await createHarness(() => 4);
    const manualDefinition: NamedStrategy = {
      topology: { mode: "parallel-dag" },
      maxParallel: 2,
      maxReworkAttempts: 2,
      roleProfiles: {},
      approvalGates: ["final"],
    };
    await harness.strategies.save("auto-evolved", manualDefinition, { expectedBefore: null });
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
      {
        createSessionId: () => "conflicting-session",
        proposeCandidate: async () => ({ rationale: "Must not run", definition: candidateDefinition }),
      },
    );

    controller.start(1);
    const snapshot = await controller.wait();

    expect(snapshot).toMatchObject({ status: "failed", completedCycles: 0 });
    expect(snapshot.error).toContain("without matching active application proof");
    expect(harness.strategies.customDefinition("auto-evolved")).toEqual(manualDefinition);
    expect((await harness.coordinator.readControlSnapshot()).catalog.proposals).toEqual([]);
    await closeHarness(harness);
  });

  it("rejects a candidate that expands the incumbent resource budget", async () => {
    const harness = await createHarness(() => 4);
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
      {
        createSessionId: () => "budget-session",
        proposeCandidate: async () => ({
          rationale: "Spend substantially more resources",
          definition: { ...candidateDefinition, maxAgentInvocations: 1_000 },
        }),
      },
    );

    controller.start(1, "budget-command", "session:budget-owner");
    const snapshot = await controller.wait();

    expect(snapshot).toMatchObject({ status: "failed", completedCycles: 0 });
    expect(snapshot.error).toContain("cannot increase maxAgentInvocations");
    expect((await harness.coordinator.readControlSnapshot()).catalog.proposals).toEqual([]);
    await closeHarness(harness);
  });

  it("cancels a proposer in flight and releases exclusive project ownership", async () => {
    const harness = await createHarness(() => 4);
    let proposerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      proposerStarted = resolve;
    });
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
      {
        createSessionId: () => "stopped-session",
        proposeCandidate: async (_context, signal) => {
          proposerStarted();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    );

    controller.start(3, "stopped-command", "session:stop-owner");
    await started;
    expect(controller.start(3, "stopped-command", "session:stop-owner"))
      .toMatchObject({ status: "running", sessionId: "stopped-session" });
    expect(() => controller.start(3, "stopped-command", "session:other-owner"))
      .toThrow("already used for another request");
    const stopped = await controller.stop("Stopped by test operator");

    expect(stopped).toMatchObject({
      status: "stopped",
      completedCycles: 0,
      stopReason: "Stopped by test operator",
    });
    const ordinary = harness.supervisor.start({ goal: "Ownership was released", profileOverrides: {} });
    await expect(harness.supervisor.wait(ordinary.runId)).resolves.toBeDefined();
    await closeHarness(harness);
  });

  it("cancels an active candidate evaluation and removes its shadow strategy", async () => {
    let candidateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      candidateStarted = resolve;
    });
    const harness = await createHarness(() => 10, {
      runWorkflow: async (request, context) => {
        const strategy = request.strategy ?? "balanced";
        if (strategy.startsWith("auto-eval-")) {
          candidateStarted();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        const state = evaluationState(
          context.runId,
          "balanced",
          strategy.startsWith("auto-eval-") ? 2 : 10,
          !context.signal.aborted,
          undefined,
          request.goal,
          context.purpose,
        );
        state.strategy.name = strategy;
        if (context.signal.aborted) state.status = "cancelled";
        return state;
      },
    });
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
      {
        createSessionId: () => "candidate-stop-session",
        proposeCandidate: async () => ({
          rationale: "Candidate held for stop coverage",
          definition: candidateDefinition,
        }),
      },
    );

    controller.start(1, "candidate-stop-command", "session:stop-owner");
    await started;
    const shadowName = harness.strategies.automaticShadowNames()[0]!;
    expect(shadowName).toMatch(/^auto-eval-[a-f0-9]{24}-1$/);
    const stopped = await controller.stop("Stop candidate evaluation");

    expect(stopped).toMatchObject({ status: "stopped", completedCycles: 0 });
    expect(harness.strategies.automaticShadowNames()).not.toContain(shadowName);
    const ordinary = harness.supervisor.start({ goal: "Run after candidate stop", profileOverrides: {} });
    await expect(harness.supervisor.wait(ordinary.runId)).resolves.toBeDefined();
    await closeHarness(harness);
  });

  it("reports an active project conflict synchronously without poisoning the start command", async () => {
    const harness = await createHarness(() => 8);
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
      {
        createSessionId: () => "conflict-release-session",
        proposeCandidate: async () => ({
          rationale: "Run after the project mutation releases",
          definition: candidateDefinition,
        }),
      },
    );
    const release = harness.supervisor.beginEvolutionMutation();

    expect(() => controller.start(1, "conflict-release-command", "session:owner"))
      .toThrow("project target mutation is already in progress");
    release();
    controller.start(1, "conflict-release-command", "session:owner");
    await expect(controller.wait()).resolves.toMatchObject({ status: "completed" });
    await closeHarness(harness);
  });

  it("removes a crash-orphaned automatic shadow during runtime initialization", async () => {
    const harness = await createHarness(() => 8);
    const shadowName = "auto-eval-0123456789abcdef01234567-1";
    const unprovenName = "auto-eval-fedcba9876543210fedcba98-1";
    await harness.coordinator.propose({
      id: "auto-0123456789abcdef01234567-1",
      candidate: {
        kind: "strategy-blueprint",
        name: "auto-evolved",
        definition: candidateDefinition,
      },
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
      origin: "automatic-controller-v1",
    });
    await harness.strategies.saveAutomaticShadow(shadowName, candidateDefinition);
    await harness.strategies.saveAutomaticShadow(unprovenName, candidateDefinition);
    const controller = new AutomaticEvolutionController(
      harness.loaded,
      harness.coordinator,
      harness.strategies,
      harness.supervisor,
    );

    await controller.restoreRuntimeDefault();

    expect(harness.strategies.automaticShadowNames()).toEqual([unprovenName]);
    expect(harness.strategies.customDefinition(shadowName)).toBeUndefined();
    expect(harness.strategies.customDefinition(unprovenName)).toEqual(candidateDefinition);
    await closeHarness(harness);
  });
});

interface AutomationHarness {
  root: string;
  loaded: LoadedConfig;
  strategies: StrategyBlueprintCatalog;
  coordinator: EvolutionApplicationCoordinator;
  supervisor: RunSupervisor;
  events: SqliteEventStore;
}

async function createHarness(
  invocationsForStrategy: (strategy: string) => number,
  limits: {
    maxCycles?: number;
    noImprovement?: number;
    runWorkflow?: NonNullable<SupervisorDependencies["runWorkflow"]>;
  } = {},
): Promise<AutomationHarness> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-auto-evolution-"));
  const config = createAutomaticConfig("automatic-evolution");
  config.evolution.automatic.maxCycles = limits.maxCycles ?? 3;
  config.evolution.automatic.maxConsecutiveNoImprovement = limits.noImprovement ?? 2;
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config), "utf8");
  await writeFile(path.join(root, ".gitignore"), ".agent-team/\n", "utf8");
  await writeFile(path.join(root, "README.md"), "automatic evolution fixture\n", "utf8");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Automatic Evolution Fixture"]);
  await git(root, ["add", "agent-team.yaml", ".gitignore", "README.md"]);
  await git(root, ["commit", "-m", "initial fixture"]);

  let loaded = await loadConfig(root);
  const strategies = await StrategyBlueprintCatalog.open(loaded);
  loaded = strategies.loaded;
  const events = new SqliteEventStore(path.join(root, ".agent-team", "control.sqlite"));
  const supervisor = new RunSupervisor(loaded, events, {
    runWorkflow: limits.runWorkflow ?? (async (request, context) => evaluationState(
      context.runId,
      request.strategy ?? loaded.config.strategies!.default,
      invocationsForStrategy(request.strategy ?? loaded.config.strategies!.default),
      true,
      loaded,
      request.goal,
      context.purpose,
    )),
  });
  const catalog = await DurableEvolutionCatalog.open(loaded);
  const coordinator = await EvolutionApplicationCoordinator.open({
    catalog,
    strategies,
    git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
    loaded,
    assertQuiescent: () => supervisor.assertEvolutionQuiescent(),
  });
  return { root, loaded, strategies, coordinator, supervisor, events };
}

async function reopenHarness(root: string): Promise<AutomationHarness> {
  let loaded = await loadConfig(root);
  const strategies = await StrategyBlueprintCatalog.open(loaded);
  loaded = strategies.loaded;
  const events = new SqliteEventStore(path.join(root, ".agent-team", "control.sqlite"));
  const supervisor = new RunSupervisor(loaded, events);
  const catalog = await DurableEvolutionCatalog.open(loaded);
  const coordinator = await EvolutionApplicationCoordinator.open({
    catalog,
    strategies,
    git: new GitManager(root, path.join(root, ".agent-team", "worktrees")),
    loaded,
    assertQuiescent: () => supervisor.assertEvolutionQuiescent(),
  });
  return { root, loaded, strategies, coordinator, supervisor, events };
}

function createAutomaticConfig(name: string) {
  const config = createDefaultConfig(name);
  config.quality.commands = [{ command: "node", args: ["-e", "process.exit(0)"] }];
  config.evolution.automatic = {
    ...config.evolution.automatic,
    enabled: true,
    maxCycles: 3,
    maxConsecutiveNoImprovement: 2,
    evaluationGoal: "Improve a fixed reliability fixture and run all local quality gates.",
    baselineStrategy: "balanced",
  };
  return config;
}

function evaluationState(
  runId: string,
  strategyName: string,
  agentInvocations: number,
  passed: boolean,
  loaded?: LoadedConfig,
  goal = "fixed evaluation goal",
  purpose: RunState["purpose"] = "evolution-evaluation",
): RunState {
  const now = new Date().toISOString();
  const strategy = loaded
    ? resolveStrategy(loaded.config, strategyName)
    : resolveStrategy(createDefaultConfig("score-fixture"), "balanced");
  return {
    id: runId,
    goal,
    root: loaded?.root ?? "/tmp",
    configPath: loaded?.path ?? "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: `agent-team/${runId}/integration`,
    integrationWorktree: `/tmp/${runId}`,
    status: passed ? "completed" : "blocked",
    purpose,
    createdAt: now,
    updatedAt: now,
    profileOverrides: {},
    strategy,
    tasks: [{
      task: {
        id: "task-1",
        title: "Improve fixture",
        description: "Make a bounded reliability improvement",
        dependsOn: [],
        ownedPaths: ["README.md"],
        acceptanceCommands: [],
        profile: null,
      },
      status: passed ? "merged" : "blocked",
      attempts: passed ? 1 : 2,
    }],
    finalQuality: {
      passed,
      commands: [{
        spec: { command: "pnpm", args: ["check"] },
        exitCode: passed ? 0 : 1,
        stdout: "excluded from automatic evidence",
        stderr: "excluded from automatic evidence",
        durationMs: 1,
        timedOut: false,
      }],
    },
    finalDecision: { decision: passed ? "ready" : "escalate", reason: "fixture verdict" },
    usage: {
      agentInvocations,
      agentDurationMs: 1,
      processOutputBytes: 1,
      truncatedStreams: 0,
      artifactBytes: 1,
    },
    history: [],
  };
}

async function closeHarness(harness: AutomationHarness): Promise<void> {
  await harness.coordinator.close();
  await harness.supervisor.close();
  harness.events.close();
}

async function git(root: string, args: string[]): Promise<void> {
  const result = await runProcess({ command: "git", args, cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}
