import { describe, expect, it, vi } from "vitest";
import { PlanningStage } from "../src/workflow/planning.js";
import { assessPlanCompleteness } from "../src/domain/plan.js";
import type { ExploreSummary, TaskPlan } from "../src/domain/contracts.js";

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
  } as TaskPlan;
}

function design(patch: Record<string, unknown> = {}) {
  return {
    elements: [{ id: "export", name: "导出", kind: "module", responsibility: "导出", paths: ["src"] }],
    relations: [],
    sequence: [],
    ...patch,
  };
}

function stage(options: { roles?: Record<string, unknown>; plan?: unknown } = {}) {
  const env = {
    loaded: { config: { project: { name: "demo" }, roles: options.roles ?? { worker: { allowedProfiles: ["p"] } } } },
  } as never;
  const checkpoints = { save: vi.fn() } as never;
  return new PlanningStage(env, checkpoints);
}

function context(plans: unknown[], overrides: Record<string, unknown> = {}) {
  const runStructured = vi.fn(async () => ({
    value: plans.shift() ?? plan(),
    profileName: "fake",
    usedFallback: false,
    text: "{}",
  }));
  return {
    state: {
      id: "run-1",
      goal: "实现导出功能",
      baseCommit: "abc",
      intake: { goalSummary: "g", instructionsForArchitect: "拆分" },
      strategy: { roleProfiles: {}, explore: undefined },
      history: [],
    },
    store: {
      transition: vi.fn(async () => undefined),
      emit: vi.fn(),
      artifactDirectory: vi.fn(() => "/tmp/agent-team-explore"),
    },
    agent: { runStructured },
    ...overrides,
  } as never;
}

describe("architectPlan", () => {
  it("accepts the first plan when it is complete", async () => {
    const ctx = context([plan({ design: design() } as never)]);
    const result = await stage().architectPlan(ctx);
    expect(result.summary).toBe("独立任务");
    expect((ctx as never as { agent: { runStructured: ReturnType<typeof vi.fn> } }).agent.runStructured).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first plan lacks a design", async () => {
    const first = plan();
    const second = plan({ design: design() } as never);
    const ctx = context([first, second]);
    const result = await stage().architectPlan(ctx);
    expect(result.summary).toBe("独立任务");
    expect((ctx as never as { agent: { runStructured: ReturnType<typeof vi.fn> } }).agent.runStructured).toHaveBeenCalledTimes(2);
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
    const ctx = context([plan({ design: design() } as never)]);
    (ctx as never as { state: { intake: unknown } }).state.intake = undefined;
    await expect(stage().architectPlan(ctx)).rejects.toThrow(/goal intake/);
  });
});

describe("maybeExplore", () => {
  const explore = { enabled: true, maxInjectedChars: 400, failOpen: true } as never;

  it("does nothing when exploration is disabled", async () => {
    const ctx = context([]);
    const result = await stage().maybeExplore(
      (ctx as never as { state: never }).state,
      (ctx as never as { store: never }).store,
      (ctx as never as { agent: never }).agent,
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
    const state = { ...(ctx as never as { state: object }).state, strategy: { roleProfiles: {}, explore } };
    const result = await stage({ roles: { researcher: {}, worker: {} } }).maybeExplore(
      state as never,
      (ctx as never as { store: never }).store,
      (ctx as never as { agent: never }).agent,
      "目标",
      "abc",
      undefined,
    );
    expect(result?.summary).toBe("找到 2 个模块");
    expect((ctx as never as { store: { emit: ReturnType<typeof vi.fn> } }).store.emit).toHaveBeenCalledWith(
      "run-1",
      "run.explore.completed",
      expect.objectContaining({ success: true }),
    );
  });

  it("fails open when the researcher throws", async () => {
    const ctx = context([]);
    (ctx as never as { agent: { runStructured: ReturnType<typeof vi.fn> } }).agent.runStructured.mockRejectedValue(
      new Error("boom"),
    );
    const state = { ...(ctx as never as { state: object }).state, strategy: { roleProfiles: {}, explore } };
    const result = await stage().maybeExplore(
      state as never,
      (ctx as never as { store: never }).store,
      (ctx as never as { agent: never }).agent,
      "目标",
      "abc",
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it("rethrows when failOpen is off", async () => {
    const ctx = context([]);
    (ctx as never as { agent: { runStructured: ReturnType<typeof vi.fn> } }).agent.runStructured.mockRejectedValue(
      new Error("boom"),
    );
    const state = {
      ...(ctx as never as { state: object }).state,
      strategy: { roleProfiles: {}, explore: { ...explore, failOpen: false } },
    };
    await expect(
      stage().maybeExplore(
        state as never,
        (ctx as never as { store: never }).store,
        (ctx as never as { agent: never }).agent,
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
    expect(assessPlanCompleteness({ tasks: [] }, "没有编号").status).toBe("complete");
  });
});
