import { describe, expect, it } from "vitest";
import type { AgentInvocationActivity } from "../web/src/agent-activity.js";
import { deriveLiveStatus, formatElapsed } from "../web/src/live-status.js";
import { deriveTimeline, filterTimeline, timelineKindCounts } from "../web/src/timeline.js";
import type { RunEvent, RunState } from "../web/src/types.js";

describe("web timeline", () => {
  it("merges history and typed events newest first", () => {
    const entries = deriveTimeline(
      { history: [{ at: "2026-08-11T18:00:00.000Z", status: "created", message: "运行已创建" }] },
      [
        event(1, "agent.invocation.started", { role: "worker", profile: "codex-worker" }),
        event(2, "agent.invocation.completed", { role: "worker", profile: "codex-worker", success: false }),
        event(3, "approval.requested", { gate: "plan" }),
        event(4, "approval.responded", { gate: "plan", decision: "rejected", reason: "范围太大" }),
        event(5, "agent.output", { text: "ignored" }),
      ],
    );
    expect(entries.map((entry) => entry.title)).toEqual([
      "审批已驳回",
      "等待人工审批",
      expect.stringContaining("失败"),
      expect.stringContaining("开始工作"),
      expect.any(String),
    ]);
    expect(entries[0]).toMatchObject({ kind: "gate", tone: "danger", detail: "范围太大" });
    expect(entries.at(-1)).toMatchObject({ kind: "flow", detail: "运行已创建" });
  });

  it("marks approved gates as success and skips malformed jev events", () => {
    const entries = deriveTimeline(undefined, [
      event(1, "approval.responded", { gate: "final", decision: "approved" }),
      event(2, "run.jev.decided", { source: "unknown" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "gate", tone: "success", detail: "final" });
  });

  it("summarizes long task lists and classifies blocked waves as danger", () => {
    const [entry] = deriveTimeline(undefined, [
      event(1, "run.wave.completed", { status: "blocked", taskIds: ["a", "b", "c", "d", "e"] }),
    ]);
    expect(entry).toMatchObject({ kind: "flow", tone: "danger", detail: "a、b、c、d 等 5 个" });
  });

  it("filters by kind and counts entries", () => {
    const entries = deriveTimeline(undefined, [
      event(1, "agent.invocation.started", { role: "worker" }),
      event(2, "agent.profile.failed", { role: "worker", profile: "x", failure: { message: "boom" } }),
      event(3, "run.advisor.consulted", { trigger: "repeated-failure", recommendation: "retry", summary: "ok" }),
    ]);
    expect(timelineKindCounts(entries)).toEqual({ agent: 1, advisor: 1, flow: 0, gate: 0, issue: 1 });
    expect(filterTimeline(entries, new Set())).toHaveLength(3);
    expect(filterTimeline(entries, new Set(["issue"] as const)).map((entry) => entry.detail)).toEqual(["boom"]);
  });
});

describe("web live status", () => {
  it("is empty without a run and idle for finished runs", () => {
    expect(deriveLiveStatus(undefined, [])).toBeUndefined();
    const status = deriveLiveStatus(runState({ status: "completed" }), [invocation("a", "running")]);
    expect(status).toMatchObject({ running: false, workers: [], hiddenWorkers: 0 });
  });

  it("lists running workers, counts tasks and pending approvals", () => {
    const run = runState({
      status: "implementing",
      approvals: [
        { id: "1", gate: "plan", status: "pending" },
        { id: "2", gate: "final", status: "approved" },
      ],
      tasks: [{ status: "merged" }, { status: "passed" }, { status: "running" }],
    });
    const invocations = ["a", "b", "c", "d"].map((id) => invocation(id, "running"));
    invocations.push(invocation("e", "completed"));
    const status = deriveLiveStatus(run, invocations);
    expect(status).toMatchObject({
      running: true,
      tasksDone: 2,
      tasksTotal: 3,
      pendingApprovals: 1,
      hiddenWorkers: 1,
      invocations: { used: 5, max: 64 },
      advisor: { used: 1, max: 3 },
    });
    expect(status?.workers).toHaveLength(3);
  });

  it("formats elapsed time", () => {
    const start = "2026-08-11T18:00:00.000Z";
    const at = (seconds: number) => Date.parse(start) + seconds * 1000;
    expect(formatElapsed(start, at(5))).toBe("5 秒");
    expect(formatElapsed(start, at(125))).toBe("2 分 5 秒");
    expect(formatElapsed(start, at(3_900))).toBe("1 小时 5 分");
    expect(formatElapsed("not a date", at(1))).toBe("—");
  });
});

describe("timeline event builders", () => {
  const build = (type: string, payload: unknown) =>
    deriveTimeline(undefined, [event(1, type, payload)])[0];

  it("maps agent lifecycle and failure shapes", () => {
    expect(build("agent.profile.failed", { role: "worker", profile: "p1", failure: { message: "boom" } }))
      .toMatchObject({ kind: "issue", tone: "danger", title: expect.stringContaining("p1"), detail: "boom" });
    expect(build("agent.profile.failed", { role: "worker", failure: { reason: "why" } })).toMatchObject({ detail: "why" });
    expect(build("agent.profile.failed", { role: "worker", failure: { kind: "timeout" } })).toMatchObject({ detail: "timeout" });
    expect(build("agent.profile.failed", { role: "worker", failure: "plain text" })).toMatchObject({ detail: "plain text" });
    expect(build("agent.profile.failed", { role: "worker" })).toMatchObject({ kind: "issue" });
    expect(build("agent.profile.skipped", { role: "worker", profile: "p2", reason: "no auth" }))
      .toMatchObject({ tone: "warning", detail: "no auth" });
    expect(build("agent.profile.skipped", { role: "worker" })).toMatchObject({ title: expect.stringContaining("候选") });
  });

  it("maps wave, explore and advisor events", () => {
    expect(build("run.wave.started", { taskIds: ["T1", "T2"] })).toMatchObject({ kind: "flow", tone: "active", detail: "T1、T2" });
    expect(build("run.wave.completed", { status: "blocked" })).toMatchObject({ tone: "danger" });
    expect(build("run.wave.completed", { status: "rework" })).toMatchObject({ tone: "warning" });
    expect(build("run.wave.completed", { status: "ok" })).toMatchObject({ tone: "success" });
    expect(build("run.wave.started", { taskIds: "nope" })).toMatchObject({ kind: "flow" });

    expect(build("run.explore.started", {})).toMatchObject({ title: "开始探索代码库" });
    expect(build("run.explore.completed", { success: true })).toMatchObject({ tone: "success" });
    expect(build("run.explore.completed", { success: false, error: "net" })).toMatchObject({ kind: "issue", detail: "net" });

    expect(build("run.advisor.consulted", { trigger: "plan", recommendation: "stop", summary: "risky" }))
      .toMatchObject({ kind: "advisor", tone: "danger" });
    expect(build("run.advisor.consulted", { trigger: "plan", recommendation: "continue" })).toMatchObject({ tone: "success" });
    expect(build("run.advisor.skipped", {})).toMatchObject({ kind: "advisor", tone: "warning" });
    expect(build("run.advisor.failed", { error: "timeout" })).toMatchObject({ kind: "issue", detail: "timeout" });
  });

  it("maps jev decisions and run lifecycle events", () => {
    const jev = build("run.jev.decided", { source: "jev", decision: "consult", confidence: 0.4, consult: true });
    expect(jev).toMatchObject({ kind: "advisor", tone: "neutral", title: "Jev 分流" });
    expect(typeof jev?.detail).toBe("string");
    expect(build("run.jev.decided", { source: "deterministic", changedOutcome: true })).toMatchObject({ title: "Jev 分流" });

    expect(build("run.crashed", { error: "segfault" })).toMatchObject({ kind: "issue", tone: "danger", detail: "segfault" });
    expect(build("run.pause-requested", {})).toMatchObject({ title: "已请求暂停" });
    expect(build("run.cancel-requested", {})).toMatchObject({ title: "已请求取消" });
    expect(build("run.resume-requested", {})).toMatchObject({ title: "已请求恢复" });
    expect(build("run.recovered", {})).toMatchObject({ title: "已从检查点恢复" });
    expect(build("run.unknown-type", {})).toBeUndefined();
  });

  it("handles non-object payloads and long task lists", () => {
    expect(deriveTimeline(undefined, [event(1, "run.wave.started", ["a"])])).toHaveLength(1);
    const long = deriveTimeline(undefined, [event(1, "run.wave.started", { taskIds: ["T1", "T2", "T3", "T4", "T5"] })]);
    expect(long[0]?.detail).toContain("等 5 个");
  });
});

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    schemaVersion: 1,
    runId: "run-timeline",
    type,
    occurredAt: `2026-08-11T18:00:${String(10 + sequence).padStart(2, "0")}.000Z`,
    payload,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  };
}

function invocation(id: string, status: AgentInvocationActivity["status"]): AgentInvocationActivity {
  return {
    id,
    role: "worker",
    profile: `profile-${id}`,
    adapter: "codex",
    status,
    startedAt: "2026-08-11T18:00:00.000Z",
    updatedAt: "2026-08-11T18:00:00.000Z",
    children: [],
  };
}

function runState(overrides: Record<string, unknown>): RunState {
  return {
    id: "run-timeline",
    goal: "goal",
    status: "implementing",
    strategy: {
      name: "default",
      maxParallel: 2,
      maxReworkAttempts: 1,
      executionTimeoutSeconds: 600,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1,
      maxArtifactBytes: 1,
      roleProfiles: {},
      approvalGates: [],
      approvalTimeoutSeconds: 60,
      advisor: { enabled: true, triggers: [], maxConsultationsPerRun: 3 },
    },
    profileOverrides: {},
    createdAt: "2026-08-11T18:00:00.000Z",
    updatedAt: "2026-08-11T18:00:00.000Z",
    tasks: [],
    history: [],
    advisorConsultations: 1,
    usage: { agentInvocations: 5 },
    ...overrides,
  } as unknown as RunState;
}
