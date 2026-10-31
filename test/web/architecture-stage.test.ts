import { describe, expect, it } from "vitest";
import {
  buildArchitectureDiagram,
  currentStageId,
  describeStage,
  presentArchitecture,
  stageForTask,
} from "../../web/src/architecture.js";
import type { ArchitectureDesign, RunEvent, TaskRunState } from "../../web/src/types.js";
import { runState } from "../support/web-fixtures.js";

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    sequence,
    id: `e-${sequence}`,
    schemaVersion: 1,
    runId: "run-fixture",
    type,
    occurredAt: "2026-08-11T18:00:00.000Z",
    payload,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  } as RunEvent;
}

function task(id: string, patch: Record<string, unknown> = {}): TaskRunState {
  return {
    task: {
      id,
      title: `任务 ${id}`,
      description: "",
      dependsOn: [],
      ownedPaths: [`src/${id}/index.ts`],
      acceptanceCommands: [],
      profile: null,
    },
    status: "working",
    attempts: 1,
    ...patch,
  } as unknown as TaskRunState;
}

const RICH_EVENTS: RunEvent[] = [
  event(1, "agent.invocation.started", { role: "worker", invocationId: "i1", profile: "kimi-worker" }),
  event(2, "agent.stdout", { role: "worker", invocationId: "i1", text: "  building  " }),
  event(3, "agent.stderr", { role: "worker", invocationId: "i1", text: "warn" }),
  event(4, "agent.invocation.completed", { role: "worker", invocationId: "i1", success: false, profile: "kimi-worker" }),
  event(5, "run.wave.started", { taskIds: ["T1", "T2"] }),
  event(6, "run.wave.completed", { taskIds: ["T1"], status: "blocked" }),
  event(7, "run.advisor.consulted", { summary: "split it" }),
  event(8, "flow.triage", { recommendation: "retry" }),
  event(9, "quality.flaky", {}),
  event(10, "approval.requested", { gate: "plan" }),
  event(11, "approval.resolved", { gate: "final" }),
  event(12, "agent.profile.skipped", { role: "worker" }),
];

describe("describeStage", () => {
  it("describes the intake stage with its artifact and input", () => {
    const run = runState({ intake: { goalSummary: "理解目标", instructionsForArchitect: "看清入口" } });
    const brief = describeStage(run, "intake");
    expect(brief.hint).toBeTruthy();
    expect(brief.artifact).toMatchObject({ title: "目标理解", body: "理解目标" });
    expect(brief.input).toBe(run.goal);
    expect(brief.ledger).toEqual([]);
  });

  it("describes explore and plan artifacts (design and summary paths)", () => {
    const explore = runState({
      intake: { goalSummary: "g", instructionsForArchitect: "look here" },
      explore: { summary: "找到 3 个模块", modules: ["cart", "order"], riskPaths: ["src/cart"] },
    });
    expect(describeStage(explore, "explore").artifact?.body).toContain("模块：cart、order");
    expect(describeStage(explore, "explore").input).toBe("look here");
    expect(describeStage(explore, "plan").input).toBe("找到 3 个模块");

    const withDesign = runState({
      plan: {
        summary: "计划摘要",
        tasks: [],
        design: {
          source: "architect",
          summary: "系统设计",
          elements: [{ name: "Cart", responsibility: "owns cart", paths: ["src/cart"] }],
          relations: [],
        },
      },
    });
    expect(describeStage(withDesign, "plan").artifact).toMatchObject({ title: "架构设计" });
    expect(describeStage(withDesign, "plan").artifact?.body).toContain("Cart：owns cart");

    const controller = runState({
      plan: {
        summary: "s",
        tasks: [],
        design: {
          source: "controller",
          summary: "控制面",
          elements: [],
          relations: [],
        },
      },
    });
    expect(describeStage(controller, "plan").artifact?.title).toBe("控制面设计");

    const noDesign = runState({ plan: { summary: "普通计划", tasks: [] } });
    expect(describeStage(noDesign, "plan").artifact).toMatchObject({ title: "任务计划" });
  });

  it("describes build and review stages with agents, live text and ledger", () => {
    const run = runState({
      status: "implementing",
      tasks: [task("T1"), task("T2", { status: "pending" })],
    });
    const build = describeStage(run, "build", RICH_EVENTS);
    expect(build.agents.length).toBeGreaterThan(0);
    expect(build.agents[0]).toMatchObject({ status: "failed" });
    expect(build.liveText).toBe("warn");
    expect(build.ledger.map((line) => line.label)).toContain("开始一批任务");
    expect(build.tasks.map((entry) => entry.task.id)).toContain("T1");
    expect(build.retries).toBeGreaterThan(0);

    const review = describeStage(run, "review", RICH_EVENTS);
    expect(review.ledger.map((line) => line.label)).toEqual(
      expect.arrayContaining(["重试或请教", "不稳定命令重跑"]),
    );
  });

  it("describes gates, approval and ship inputs", () => {
    const run = runState({
      finalQuality: { passed: false, commands: [{ spec: { command: "pnpm", args: ["test"] }, exitCode: 1 }] },
      approvals: [
        {
          id: "a-1",
          gate: "final",
          status: "pending",
          summary: "等待交付确认",
          checkpointId: "c",
          requestedAt: "2026-08-11T18:00:00.000Z",
          expiresAt: "2026-08-11T19:00:00.000Z",
        },
      ],
      finalDecision: { decision: "ready", reason: "全部门禁通过" },
      pullRequestUrl: "http://pr/1",
    });
    expect(describeStage(run, "gates").artifact?.body).toContain("未通过");
    expect(describeStage(run, "gates").input).toContain("pnpm test");

    expect(describeStage(run, "approval").input).toBe("等待交付确认");
    expect(describeStage(run, "approval").artifact?.body).toBe("全部门禁通过");
    expect(describeStage(run, "ship").input).toBe("http://pr/1");
    expect(describeStage(run, "ship").artifact?.title).toBe("最终决定");
  });

  it("labels approval ledger lines and matches tasks to design elements", () => {
    const run = runState({
      tasks: [task("T1"), task("T2", { status: "merged" })],
    });
    const approval = describeStage(run, "approval", RICH_EVENTS);
    expect(approval.ledger.map((line) => line.label)).toEqual(
      expect.arrayContaining(["请求审批", "审批结果"]),
    );

    const design: ArchitectureDesign = {
      source: "architect",
      summary: "设计",
      elements: [
        { id: "cart", name: "Cart", kind: "module", responsibility: "cart", paths: ["src/cart"] },
        { id: "all", name: "All", kind: "module", responsibility: "everything", paths: ["src"] },
      ],
      relations: [],
      sequence: [],
    };
    const diagram = presentArchitecture([task("T1"), task("T2")], design).diagram;
    expect(diagram.boxes.length).toBeGreaterThanOrEqual(2);
    expect(diagram.boxes.every((box) => typeof box.x === "number")).toBe(true);
  });

  it("tracks reviewer progress and wildcard path coverage", () => {
    const events = [
      event(1, "agent.invocation.started", { role: "reviewer", invocationId: "r1" }),
      event(2, "agent.stdout", { role: "reviewer", invocationId: "r1", text: "looks fine" }),
      event(3, "agent.invocation.completed", { role: "reviewer", invocationId: "r1", success: true }),
      // Output from an invocation that was never started is ignored.
      event(4, "agent.stdout", { role: "reviewer", invocationId: "ghost", text: "ignored" }),
      event(5, "agent.invocation.completed", { role: "tester" }),
    ];
    const run = runState({ tasks: [task("T1", { review: {} })] });
    const brief = describeStage(run, "review", events);
    expect(brief.agents.map((agent) => agent.status)).toEqual(["done", "done"]);
    expect(brief.liveText).toBe("looks fine");

    const design: ArchitectureDesign = {
      source: "architect",
      summary: "设计",
      elements: [
        { id: "cart", name: "Cart", kind: "module", responsibility: "cart", paths: ["src/cart/**"] },
        { id: "root", name: "Root", kind: "module", responsibility: "root", paths: [""] },
      ],
      relations: [],
      sequence: [],
    };
    const diagram = presentArchitecture([task("T1")], design).diagram;
    // "src/cart/**" covers src/cart/index.ts; the empty pattern covers everything.
    expect(diagram.boxes.length).toBe(2);
  });

  it("falls back to a pending stage for unknown ids and derives headlines", () => {
    const run = runState({ status: "completed" });
    const brief = describeStage(run, "integrate" as never);
    expect(brief.headline).toBeTruthy();

    const pending = describeStage(run, "intake");
    expect(pending.headline).toBeTruthy();
  });
});

describe("stageForTask", () => {
  it("routes every task state to a stage", () => {
    expect(stageForTask(task("T1", { status: "blocked", review: {} }))).toBe("review");
    expect(stageForTask(task("T1", { status: "blocked" }))).toBe("build");
    expect(stageForTask(task("T1", { status: "reworking" }))).toBe("build");
    expect(stageForTask(task("T1", { status: "passed", test: {} }))).toBe("review");
    expect(stageForTask(task("T1", { status: "merged" }))).toBe("integrate");
    expect(stageForTask(task("T1", { status: "pending" }))).toBe("plan");
  });

  it("reports the current stage from the run", () => {
    expect(currentStageId(runState({ status: "implementing" }))).toBeTruthy();
    // A finished run has no current or failed stage.
    expect(currentStageId(runState({ status: "completed" }))).toBeUndefined();
  });
});

describe("architecture diagrams", () => {
  it("builds modules from task paths and covers containment both ways", () => {
    const diagram = buildArchitectureDiagram([task("T1"), task("T2", { status: "pending" })]);
    expect(diagram.boxes.length).toBeGreaterThan(0);
    expect(diagram.width).toBeGreaterThan(0);
  });

  it("prefers a stored design and keeps its source", () => {
    const design: ArchitectureDesign = {
      source: "architect",
      summary: "设计摘要",
      elements: [
        { id: "cart", name: "Cart", kind: "module", responsibility: "cart", paths: ["src/cart"] },
        { id: "order", name: "Order", kind: "module", responsibility: "order", paths: ["src/order"] },
      ],
      relations: [{ from: "cart", to: "order", kind: "calls", label: "调用" }],
      sequence: [{ from: "cart", to: "order", label: "checkout" }],
    };
    const presentation = presentArchitecture([], design);
    expect(presentation.source).toBe("architect");
    expect(presentation.diagram.boxes).toHaveLength(2);
    expect(presentation.diagram.edges.length).toBeGreaterThan(0);
    expect(presentation.sequence.length).toBeGreaterThan(0);
  });

  it("infers a diagram when no design exists", () => {
    const presentation = presentArchitecture([task("T1")]);
    expect(presentation.source).toBe("inferred");
    expect(presentation.summary).toBeUndefined();
  });
});
