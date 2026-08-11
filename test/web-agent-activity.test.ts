import { describe, expect, it } from "vitest";
import {
  agentRoleLabel,
  agentStatusLabel,
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
