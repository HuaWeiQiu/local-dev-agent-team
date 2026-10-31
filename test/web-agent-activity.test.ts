import { describe, expect, it } from "vitest";
import {
  agentRoleLabel,
  agentStatusLabel,
  deriveAdvisorLog,
  deriveAgentActivity,
  retainAgentMonitorEvents,
} from "../web/src/agent-activity.js";
import type { RunEvent } from "../web/src/types.js";

describe("web agent activity", () => {
  it("groups native Codex children under their owning Agent Team invocation", () => {
    const events = [
      event(1, "agent.invocation.started", {
        invocationId: "invoke-review",
        role: "reviewer",
        profile: "codex-reviewer",
        adapter: "codex",
        model: "gpt-5.6-sol",
        artifactKey: "tasks/contracts/review",
      }),
      event(2, "agent.children.updated", {
        invocationId: "invoke-review",
        role: "reviewer",
        profile: "codex-reviewer",
        adapter: "codex",
        agents: [{
          threadId: "019ff217-2ee2-7362-9522-a2bb9d6be27c",
          path: "/root/contracts_final_review",
          status: "running",
          model: "gpt-5.6-sol",
        }],
      }),
      event(3, "agent.children.updated", {
        invocationId: "invoke-review",
        role: "reviewer",
        profile: "codex-reviewer",
        adapter: "codex",
        agents: [{
          threadId: "019ff217-2ee2-7362-9522-a2bb9d6be27c",
          path: "/root/contracts_final_review",
          status: "completed",
          model: "gpt-5.6-sol",
        }],
      }),
      event(4, "agent.invocation.completed", {
        invocationId: "invoke-review",
        role: "reviewer",
        profile: "codex-reviewer",
        adapter: "codex",
        model: "gpt-5.6-sol",
        success: true,
      }),
    ];

    expect(deriveAgentActivity(events, "completed")).toEqual([
      expect.objectContaining({
        id: "invoke-review",
        role: "reviewer",
        profile: "codex-reviewer",
        status: "completed",
        children: [expect.objectContaining({
          label: "contracts_final_review",
          status: "completed",
        })],
      }),
    ]);
    expect(agentRoleLabel("reviewer")).toBe("审查");
    expect(agentStatusLabel("running")).toBe("执行中");
  });

  it("fails closed for malformed events and marks dangling calls interrupted on terminal runs", () => {
    const activity = deriveAgentActivity([
      event(1, "agent.invocation.started", {
        invocationId: "invoke-worker",
        role: "worker",
        profile: "grok-worker",
        adapter: "grok",
      }),
      event(2, "agent.children.updated", {
        invocationId: "invoke-worker",
        role: "worker",
        profile: "grok-worker",
        adapter: "grok",
        agents: [{ threadId: "child-dangling", status: "running" }],
      }),
      event(3, "agent.children.updated", {
        invocationId: 42,
        agents: "not-an-array",
      }),
      event(4, "agent.invocation.completed", {
        invocationId: "invoke-failed",
        role: "tester",
        profile: "codex-tester",
        adapter: "codex",
        success: false,
      }),
    ], "blocked");

    expect(activity.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "invoke-failed", status: "failed" },
      { id: "invoke-worker", status: "interrupted" },
    ]);
    expect(activity.find((item) => item.id === "invoke-worker")?.children[0]?.status)
      .toBe("interrupted");
  });

  it("retains lifecycle snapshots when long output rolls beyond the UI log window", () => {
    const started = event(1, "agent.invocation.started", {
      invocationId: "invoke-long",
      role: "worker",
      profile: "grok-worker",
      adapter: "grok",
    });
    const children = event(2, "agent.children.updated", {
      invocationId: "invoke-long",
      agents: [{ threadId: "child-long", status: "running" }],
    });
    const output = Array.from({ length: 600 }, (_, index) =>
      event(index + 3, "agent.stdout", { chunk: `line ${index}` }));

    const retained = retainAgentMonitorEvents([started, children, ...output], 500);
    expect(retained).toHaveLength(502);
    expect(retained.slice(0, 2).map((item) => item.type)).toEqual([
      "agent.invocation.started",
      "agent.children.updated",
    ]);
    expect(deriveAgentActivity(retained, "implementing")[0]).toMatchObject({
      id: "invoke-long",
      status: "running",
      children: [expect.objectContaining({ status: "running" })],
    });
  });

  it("tags architect advisor invocations by their artifact key", () => {
    const events = [
      event(1, "agent.invocation.started", {
        invocationId: "invoke-advice",
        role: "architect",
        profile: "grok-architect",
        adapter: "grok",
        artifactKey: "tasks/alpha/attempt-3/advisor",
      }),
      event(2, "agent.invocation.started", {
        invocationId: "invoke-final-advice",
        role: "architect",
        profile: "grok-architect",
        adapter: "grok",
        artifactKey: "recoveries/1/pre-final-advisor",
      }),
      event(3, "agent.invocation.started", {
        invocationId: "invoke-plan",
        role: "architect",
        profile: "grok-architect",
        adapter: "grok",
        artifactKey: "architecture",
      }),
    ];
    const byId = new Map(deriveAgentActivity(events, "implementing").map((item) => [item.id, item]));
    expect(byId.get("invoke-advice")?.advisor).toBe(true);
    expect(byId.get("invoke-final-advice")?.advisor).toBe(true);
    expect(byId.get("invoke-plan")).not.toHaveProperty("advisor");
  });

  it("derives a newest-first advisor log and retains it beyond the output window", () => {
    const consulted = event(1, "run.advisor.consulted", {
      trigger: "repeated-failure",
      taskId: "alpha",
      recommendation: "change_approach",
      summary: "Fix the root cause",
    });
    const skipped = event(2, "run.advisor.skipped", { trigger: "pre-final", reason: "consultation-limit" });
    const failed = event(3, "run.advisor.failed", { trigger: "repeated-failure", taskId: "beta", error: "chain exhausted" });
    const output = Array.from({ length: 600 }, (_, index) =>
      event(index + 4, "agent.stdout", { chunk: `line ${index}` }));

    const retained = retainAgentMonitorEvents([consulted, skipped, failed, ...output], 500);
    const log = deriveAdvisorLog(retained);
    expect(log.map((entry) => [entry.status, entry.trigger])).toEqual([
      ["failed", "repeated-failure"],
      ["skipped", "pre-final"],
      ["consulted", "repeated-failure"],
    ]);
    expect(log[0]).toMatchObject({ taskId: "beta", detail: "chain exhausted" });
    expect(log[2]).toMatchObject({ taskId: "alpha", recommendation: "change_approach" });
  });

  it("includes Jev fork decisions in the advisor log and ignores malformed ones", () => {
    const log = deriveAdvisorLog([
      event(1, "run.jev.decided", {
        taskId: "alpha",
        source: "jev",
        decision: "consult",
        confidence: 0.93,
        consult: true,
        changedOutcome: true,
        latencyMs: 41,
      }),
      event(2, "run.jev.decided", { taskId: "alpha", source: "bogus" }),
      event(3, "run.jev.decided", { taskId: "beta", source: "deterministic", consult: false, changedOutcome: false }),
    ]);

    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ status: "jev", taskId: "beta", jev: { source: "deterministic" } });
    expect(log[1]?.jev).toEqual({
      source: "jev",
      decision: "consult",
      confidence: 0.93,
      consult: true,
      changedOutcome: true,
      latencyMs: 41,
    });
  });
});

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    schemaVersion: 1,
    runId: "run-agent-view",
    type,
    occurredAt: `2026-08-11T18:00:0${sequence}.000Z`,
    payload,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  };
}
