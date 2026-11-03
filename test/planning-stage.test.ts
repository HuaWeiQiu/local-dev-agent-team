import { describe, expect, it, vi } from "vitest";
import { PlanningStage } from "../src/workflow/planning.js";
import { assessPlanCompleteness } from "../src/domain/plan.js";
import type { ArchitectureDesign, ExploreSummary, TaskPlan } from "../src/domain/contracts.js";
import type { RoleAgentService } from "../src/agents/service.js";
import type { RunStateStore } from "../src/state/store.js";
import type { CheckpointService } from "../src/workflow/checkpoints.js";
import type { RunContext, RunnerEnv } from "../src/workflow/types.js";
import type { RunState } from "../src/state/types.js";

function plan(patch: Partial<TaskPlan> = {}): TaskPlan {
  return {
    summary: "独立任务",
    tasks: [
      {
        id: "T1",
        title: "实现导出",
        description: "创建导出模块",
        dependsOn: [],
        ownedPaths: ["src/export.ts"],
        acceptanceCommands: [],
        profile: null,
      },
    ],
    ...patch,
  };
}

function design(patch: Partial<ArchitectureDesign> = {}): ArchitectureDesign {
  return {
    summary: "导出模块",
    source: "architect",
    elements: [{ id: "export", name: "导出", kind: "module", responsibility: "导出", paths: ["src"] }],
    relations: [],
    sequence: [],
    ...patch,
  };
}

/** The two collaborators the stage needs; both are classes, so a stand-in has to be cast once, here. */
function stage(options: { roles?: Record<string, unknown> } = {}) {
  const env = {
    loaded: {
      config: {
        project: { name: "demo" },
        roles: options.roles ?? { worker: { allowedProfiles: ["p"] } },
      },
    },
  } as unknown as RunnerEnv;
  const checkpoints = { save: vi.fn() } as unknown as CheckpointService;
  return new PlanningStage(env, checkpoints);
}

/**
 * A run state in the shape production actually holds, so call sites need no
 * assertion to hand it to the stage.
 */
function runState(patch: Partial<RunState> = {}): RunState {
  return {
    id: "run-1",
    goal: "实现导出功能",
    root: "/tmp/run-1",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "agent-team/run-1/integration",
    integrationWorktree: "/tmp/run-1",
    status: "implementing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileOverrides: {},
    strategy: {
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
      topology: { version: 1, mode: "parallel-dag", stages: [], edges: [] },
      swarmMaxConcurrency: 2,
      explore: { enabled: false, maxInjectedChars: 400, failOpen: true },
    },
    tasks: [],
    intake: { goalSummary: "g", instructionsForArchitect: "拆分", constraints: [], risk: "low" },
    history: [],
    ...patch,
  };
}

type TestContext = RunContext & { agent: RoleAgentService & { runStructured: ReturnType<typeof vi.fn> } };

function context(plans: unknown[], overrides: Partial<RunContext> = {}): TestContext {
  const runStructured = vi.fn(async () => ({
    value: plans.shift() ?? plan(),
    profileName: "fake",
    usedFallback: false,
    text: "{}",
  }));
  return {
    state: runState(),
    store: {
      transition: vi.fn(async () => undefined),
      emit: vi.fn(),
      artifactDirectory: vi.fn(() => "/tmp/agent-team-explore"),
    } as unknown as RunStateStore,
    git: {} as unknown as RunContext["git"],
    budget: {} as unknown as RunContext["budget"],
    ...overrides,
    // Last, so the mock stays a mock: `overrides` would widen it back to the
    // interface and every `mockRejectedValue` call below would lose its type.
    agent: { runStructured } as unknown as TestContext["agent"],
  };
}

describe("architectPlan", () => {
  it("accepts the first plan when it is complete", async () => {
    const ctx = context([plan({ design: design() })]);
    const result = await stage().architectPlan(ctx);
    expect(result.summary).toBe("独立任务");
    expect(ctx.agent.runStructured).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first plan lacks a design", async () => {
    const first = plan();
    const second = plan({ design: design() });
    const ctx = context([first, second]);
    const result = await stage().architectPlan(ctx);
    expect(result.summary).toBe("独立任务");
    expect(ctx.agent.runStructured).toHaveBeenCalledTimes(2);
  });

  it("falls back to the named plan when both attempts are rejected", async () => {
    const broken = plan({ tasks: [] });
    const ctx = context([broken, broken], {
      planningGoal: "Implement T1-T2. T1 add src/greet.js. T2 add test/greet.test.js.",
    });
    const result = await stage().architectPlan(ctx);
    expect(result.tasks.map((task) => task.id)).toEqual(["T1", "T2"]);
  });

  it("requires an intake", async () => {
    const ctx = context([plan({ design: design() })]);
    delete ctx.state.intake;
    await expect(stage().architectPlan(ctx)).rejects.toThrow(/goal intake/);
  });
});

describe("maybeExplore", () => {
  const explore = { enabled: true, maxInjectedChars: 400, failOpen: true };

  it("does nothing when exploration is disabled", async () => {
    const ctx = context([]);
    const result = await stage().maybeExplore(
      ctx.state,
      ctx.store,
      ctx.agent,
      "目标",
      "abc",
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it("records the summary and returns what was injected", async () => {
    const summary = {
      summary: "找到 2 个模块",
      modules: ["a", "b"],
      riskPaths: [],
      suggestedAcceptanceCommands: [],
      forbiddenPaths: [],
      notes: [],
    } as unknown as ExploreSummary;
    const ctx = context([summary]);
    const state = { ...ctx.state, strategy: { ...ctx.state.strategy, explore } };
    const result = await stage({ roles: { researcher: {}, worker: {} } }).maybeExplore(
      state,
      ctx.store,
      ctx.agent,
      "目标",
      "abc",
      undefined,
    );
    expect(result?.summary).toBe("找到 2 个模块");
    expect(ctx.store.emit).toHaveBeenCalledWith(
      "run-1",
      "run.explore.completed",
      expect.objectContaining({ success: true }),
    );
  });

  it("fails open when the researcher throws", async () => {
    const ctx = context([]);
    ctx.agent.runStructured.mockRejectedValue(
      new Error("boom"),
    );
    const state = { ...ctx.state, strategy: { ...ctx.state.strategy, explore } };
    const result = await stage().maybeExplore(
      state,
      ctx.store,
      ctx.agent,
      "目标",
      "abc",
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it("rethrows when failOpen is off", async () => {
    const ctx = context([]);
    ctx.agent.runStructured.mockRejectedValue(
      new Error("boom"),
    );
    const state = {
      ...ctx.state,
      strategy: { ...ctx.state.strategy, explore: { ...explore, failOpen: false } },
    };
    await expect(
      stage().maybeExplore(
        state,
        ctx.store,
        ctx.agent,
        "目标",
        "abc",
        undefined,
      ),
    ).rejects.toThrow("boom");
  });
});

describe("controller plan", () => {
  it("returns a named plan only when it is complete", () => {
    const s = stage();
    expect(s.controllerPlan("Implement T1-T2. T1 add src/greet.js. T2 add test/greet.test.js.", false)).toBeTruthy();
    expect(s.controllerPlan("随便说点什么", false)).toBeUndefined();
  });
});

describe("plan completeness helper", () => {
  it("matches the exported rules", () => {
    expect(assessPlanCompleteness(plan({ tasks: [] }), "没有编号").status).toBe("complete");
  });
});
