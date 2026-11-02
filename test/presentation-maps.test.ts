import { describe, expect, it } from "vitest";
import type { AgentInvocationActivity } from "../web/src/agent-activity.js";
import { deriveLiveStatus } from "../web/src/live-status.js";
import { deriveStages } from "../web/src/stages.js";
import type { RunEvent, RunState } from "../web/src/types.js";
import { foldFlowEvents } from "../src/flow/fold.js";

function runState(patch: Partial<RunState> = {}): RunState {
  return {
    id: "r1",
    status: "implementing",
    createdAt: "2026-08-11T09:00:00.000Z",
    tasks: [],
    approvals: [],
    usage: { agentInvocations: 0 },
    advisorConsultations: 0,
    strategy: {
      maxAgentInvocations: 64,
      advisor: { enabled: false, maxConsultationsPerRun: 2 },
    },
    ...patch,
  } as unknown as RunState;
}

function invocation(id: string, patch: Partial<AgentInvocationActivity> = {}): AgentInvocationActivity {
  return {
    id,
    role: "worker",
    profile: "grok-worker",
    status: "running",
    ...patch,
  } as AgentInvocationActivity;
}

describe("deriveLiveStatus", () => {
  it("shows at most three workers and counts the rest as hidden", () => {
    const status = deriveLiveStatus(runState(), [
      invocation("a"),
      invocation("b"),
      invocation("c"),
      invocation("d"),
      invocation("e"),
    ]);

    expect(status?.workers.map((worker) => worker.id)).toEqual(["a", "b", "c"]);
    expect(status?.hiddenWorkers).toBe(2);
    expect(status?.running).toBe(true);
  });

  it("labels a worker with its role label and profile and flags advisors", () => {
    const status = deriveLiveStatus(runState(), [invocation("a", { advisor: true })]);

    expect(status?.workers[0]?.advisor).toBe(true);
    expect(status?.workers[0]?.label).toContain("grok-worker");
  });

  it("does not treat an advisor flag other than true as an advisor", () => {
    const status = deriveLiveStatus(runState(), [invocation("a", { advisor: false })]);

    expect(status?.workers[0]?.advisor).toBe(false);
  });

  it("ignores running invocations once the run stopped running", () => {
    const status = deriveLiveStatus(runState({ status: "completed" }), [invocation("a")]);

    expect(status?.workers).toEqual([]);
    expect(status?.running).toBe(false);
  });

  it("counts passed and merged tasks only", () => {
    const status = deriveLiveStatus(
      runState({
        tasks: [
          { status: "passed" },
          { status: "merged" },
          { status: "failed" },
          { status: "pending" },
        ] as RunState["tasks"],
      }),
      [],
    );

    expect(status).toMatchObject({ tasksDone: 2, tasksTotal: 4 });
  });

  it("counts pending approvals only", () => {
    const status = deriveLiveStatus(
      runState({
        approvals: [{ status: "pending" }, { status: "approved" }, { status: "pending" }],
      } as Partial<RunState>),
      [],
    );

    expect(status?.pendingApprovals).toBe(2);
  });

  it("has no advisor budget when the strategy configures none", () => {
    const status = deriveLiveStatus(
      runState({ strategy: { maxAgentInvocations: 8 } } as Partial<RunState>),
      [],
    );

    expect(status?.advisor).toBeUndefined();
  });

  it("reports the advisor budget only while advice is enabled", () => {
    const disabled = deriveLiveStatus(runState(), []);
    const enabled = deriveLiveStatus(
      runState({
        advisorConsultations: 1,
        strategy: {
          maxAgentInvocations: 8,
          advisor: { enabled: true, maxConsultationsPerRun: 5 },
        },
      } as Partial<RunState>),
      [],
    );

    expect(disabled?.advisor).toBeUndefined();
    expect(enabled?.advisor).toEqual({ used: 1, max: 5 });
    const unconsulted = deriveLiveStatus(
      runState({
        advisorConsultations: undefined,
        strategy: {
          maxAgentInvocations: 8,
          advisor: { enabled: true, maxConsultationsPerRun: 5 },
        },
      } as unknown as Partial<RunState>),
      [],
    );
    expect(unconsulted?.advisor).toEqual({ used: 0, max: 5 });
    expect(enabled?.invocations).toEqual({ used: 0, max: 8 });
  });
});

describe("deriveStages", () => {
  const states = (run: Parameters<typeof deriveStages>[0]) =>
    deriveStages(run).map((stage) => `${stage.id}:${stage.state}`);

  it("skips the stages a completed run never entered", () => {
    const states = deriveStages({
      status: "completed",
      history: [{ status: "created" }, { status: "implementing" }, { status: "completed" }],
    } satisfies Parameters<typeof deriveStages>[0]).map((stage) => stage.state);

    expect(states.slice(0, 3)).toEqual(["done", "skipped", "skipped"]);
    expect(states.every((state) => state === "done" || state === "skipped")).toBe(true);
  });

  it.each(["blocked", "cancelled", "interrupted"] as const)(
    "marks the last stage a %s run reached as failed",
    (status) => {
      expect(states({ status, history: [{ status: "implementing" }] })).toContain("build:failed");
    },
  );

  it("marks a failing CI as a failed ship stage", () => {
    expect(states({ status: "ci-failed", history: [] })).toContain("ship:failed");
  });

  it("parks a run with an unknown status at the last stage it reached", () => {
    const view = states({
      status: "mystery" as never,
      history: [{ status: "implementing" }, { status: "reviewing-testing" }],
    });

    expect(view).toEqual([
      "intake:skipped",
      "explore:skipped",
      "plan:skipped",
      "build:done",
      "review:current",
      "integrate:pending",
      "gates:pending",
      "approval:pending",
      "ship:pending",
    ]);
  });

  it("has nothing visited for a run without history", () => {
    expect(states({ status: "created", history: [] })).toEqual([
      "intake:current",
      "explore:pending",
      "plan:pending",
      "build:pending",
      "review:pending",
      "integrate:pending",
      "gates:pending",
      "approval:pending",
      "ship:pending",
    ]);
  });
});

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    id: `e${sequence}`,
    schemaVersion: 1,
    runId: "r1",
    type,
    occurredAt: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
    payload,
    sequence,
    traceId: "t",
    spanId: "s",
  } as RunEvent;
}

describe("foldFlowEvents", () => {
  it("reads the ledger in sequence order, whatever order it is handed in", () => {
    const progress = foldFlowEvents([
      event(3, "flow.node", { nodeId: "plan", status: "completed" }),
      event(1, "flow.selected", { mode: "flow", nodes: ["plan"] }),
      event(2, "flow.node", { nodeId: "plan", status: "started" }),
    ]);

    expect(progress.selection).toEqual({ mode: "flow", nodes: ["plan"] });
    expect(progress.nodes).toHaveLength(1);
    expect(progress.nodes[0]).toMatchObject({ nodeId: "plan", status: "completed", attempts: 1 });
    expect(progress.current).toBeUndefined();
  });

  it("counts a resume as a second attempt and clears the previous ending", () => {
    const progress = foldFlowEvents([
      event(1, "flow.node", { nodeId: "build", status: "started" }),
      event(2, "flow.node", { nodeId: "build", status: "failed", reason: "tests red" }),
      event(3, "flow.node", { nodeId: "build", status: "started" }),
    ]);

    expect(progress.nodes[0]).toMatchObject({ attempts: 2, status: "started" });
    expect(progress.nodes[0]?.reason).toBeUndefined();
    expect(progress.nodes[0]?.endedAt).toBeUndefined();
    expect(progress.current).toBe("build");
  });

  it("keeps the node a run is parked at as current", () => {
    const progress = foldFlowEvents([event(1, "flow.node", { nodeId: "review", status: "parked" })]);

    expect(progress.current).toBe("review");
    expect(progress.nodes[0]).toMatchObject({ status: "parked", attempts: 0 });
  });

  it("drops the current node when a different node finishes", () => {
    const progress = foldFlowEvents([
      event(1, "flow.node", { nodeId: "build", status: "started" }),
      event(2, "flow.node", { nodeId: "review", status: "completed" }),
    ]);

    expect(progress.current).toBe("build");
    expect(progress.nodes.map((node) => node.nodeId)).toEqual(["build", "review"]);
  });

  it("clears a reason that a later status no longer carries", () => {
    const progress = foldFlowEvents([
      event(1, "flow.node", { nodeId: "gates", status: "failed", reason: "lint" }),
      event(2, "flow.node", { nodeId: "gates", status: "completed" }),
    ]);

    expect(progress.nodes[0]?.reason).toBeUndefined();
    expect(progress.nodes[0]?.endedAt).toBeTruthy();
  });

  it("collects triage decisions and ignores unrelated events", () => {
    const progress = foldFlowEvents([
      event(1, "flow.triage", { decision: "retry" }),
      event(2, "flow.triage", { decision: "consult" }),
      event(3, "agent.invocation.completed", { role: "worker" }),
    ]);

    expect(progress.triage).toEqual([{ decision: "retry" }, { decision: "consult" }]);
    expect(progress.nodes).toEqual([]);
  });
});
