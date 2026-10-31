import { describe, expect, it } from "vitest";
import { buildAgentFeed, isLiveAgentEvent } from "../web/src/agent-feed.js";
import type { RunEvent } from "../web/src/types.js";

let sequence = 0;
function event(type: string, payload: Record<string, unknown>): RunEvent {
  sequence += 1;
  return {
    sequence,
    id: `e${sequence}`,
    schemaVersion: 1,
    runId: "r1",
    type,
    occurredAt: `2026-10-03T10:00:${String(sequence).padStart(2, "0")}Z`,
    payload,
    traceId: "t",
    spanId: "s",
  };
}

const agent = { id: "a1", artifactKey: "T1-worker" };

describe("buildAgentFeed", () => {
  it("merges adjacent output and interleaves operator interventions in order", () => {
    const feed = buildAgentFeed(
      [
        event("agent.stdout", { artifactKey: "T1-worker", chunk: "reading " }),
        event("agent.stdout", { artifactKey: "T1-worker", chunk: "files" }),
        event("agent.steered", { agentId: "a1", actor: "lead", text: "use B" }),
        event("agent.stdout", { artifactKey: "T1-worker", chunk: "switching" }),
        event("agent.question", { agentId: "a1", prompt: "Which option?" }),
        event("agent.answered", { agentId: "a1", actor: "lead", answer: "A" }),
      ],
      agent,
    );
    expect(feed.map((entry) => [entry.kind, entry.text])).toEqual([
      ["output", "reading files"],
      ["steer", "use B"],
      ["output", "switching"],
      ["question", "Which option?"],
      ["answer", "A"],
    ]);
    expect(feed[1]?.actor).toBe("lead");
  });

  it("ignores other agents and never reveals redacted answers", () => {
    const feed = buildAgentFeed(
      [
        event("agent.stdout", { artifactKey: "other", chunk: "noise" }),
        event("agent.steered", { agentId: "someone-else", text: "no" }),
        event("agent.answered", { agentId: "a1", actor: "lead", redacted: true }),
        event("agent.interrupted", { agentId: "a1", actor: "lead" }),
      ],
      agent,
    );
    expect(feed.map((entry) => entry.kind)).toEqual(["answer", "interrupt"]);
    expect(feed[0]?.text).toContain("保密");
  });

  it("trims runaway output to a bounded tail", () => {
    const feed = buildAgentFeed([event("agent.stdout", { artifactKey: "T1-worker", chunk: "x".repeat(10_000) })], agent);
    expect(feed[0]!.text.length).toBeLessThan(4_100);
    expect(feed[0]!.text.startsWith("…")).toBe(true);
  });

  it("recognises events that should refresh the live agent list", () => {
    expect(isLiveAgentEvent("agent.session.opened")).toBe(true);
    expect(isLiveAgentEvent("agent.question")).toBe(true);
    expect(isLiveAgentEvent("agent.stdout")).toBe(false);
  });
});
