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
