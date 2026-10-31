import { describe, expect, it } from "vitest";
import { CodexActivityParser } from "../src/adapters/codex-events.js";

/**
 * The parser consumes JSONL from the Codex app server; these cases drive it the
 * way the stream does, one line at a time.
 */
function parser(): CodexActivityParser {
  return new CodexActivityParser();
}

function line(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("CodexActivityParser.consume", () => {
  it("ignores blank lines, malformed JSON and non-objects", () => {
    expect(parser().push("\n  \nnot json\n[]\n")).toEqual([]);
  });

  it("ignores an event without an item", () => {
    expect(parser().push(`${line({ type: "event" })}\n`)).toEqual([]);
  });

  it("emits a snapshot for a subagent activity item", () => {
    const snapshots = parser().push(
      `${line({
        type: "item/completed",
        item: {
          type: "subagent_activity",
          agent_thread_id: "thread-1",
          kind: "interrupted",
          agent_path: "/agents/a",
        },
      })}\n`,
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ type: "child-agents" });
    expect(JSON.stringify(snapshots[0])).toContain("thread-1");
  });

  it("finish flushes the current snapshot once", () => {
    const instance = parser();
    instance.push(
      `${line({ type: "item/started", item: { type: "subagent_activity", agent_thread_id: "t" } })}\n`,
    );
    const flushed = instance.finish();
    expect(Array.isArray(flushed)).toBe(true);
    expect(instance.finish()).toEqual([]);
  });
});

describe("CodexActivityParser collab calls", () => {
  it("merges declared receivers, states and receiver ids", () => {
    const snapshots = parser().push(
      `${line({
        type: "item/completed",
        item: {
          type: "collab_tool_call",
          tool: "spawnagent",
          status: "completed",
          receiver_thread_ids: ["thread-a"],
          agents_states: { "thread-b": { status: "running" } },
          receiver_agents: [{ thread_id: "thread-c", agent_path: "/c", model: "gpt" }],
          model: "fallback-model",
        },
      })}\n`,
    );
    expect(snapshots).toHaveLength(1);
    const text = JSON.stringify(snapshots[0]);
    for (const id of ["thread-a", "thread-b", "thread-c"]) expect(text).toContain(id);
    expect(text).toContain("gpt");
  });

  it("marks a closeagent call as shutdown and a failure as failed", () => {
    const closed = parser().push(
      `${line({
        type: "item/completed",
        item: { type: "collab_tool_call", tool: "closeagent", status: "completed", receiver_thread_ids: ["t1"] },
      })}\n`,
    );
    expect(JSON.stringify(closed[0])).toContain("shutdown");

    const failed = parser().push(
      `${line({
        type: "item/started",
        item: { type: "collab_tool_call", tool: "spawnagent", status: "failed", receiver_thread_ids: ["t2"] },
      })}\n`,
    );
    expect(JSON.stringify(failed[0])).toContain("failed");
  });

  it("skips an entry without a usable thread id", () => {
    expect(
      parser().push(
        `${line({
          type: "item/completed",
          item: { type: "collab_tool_call", tool: "sendinput", receiver_agents: [{ model: "m" }] },
        })}\n`,
      ),
    ).toEqual([]);
  });

  it("keeps the last known values when the item carries none", () => {
    const instance = parser();
    instance.push(
      `${line({
        type: "item/completed",
        item: {
          type: "collab_tool_call",
          tool: "sendinput",
          receiver_agents: [{ thread_id: "t1", agent_path: "/a", model: "m" }],
        },
      })}\n`,
    );
    // A status change re-emits the entry, carrying the path learned earlier.
    const later = instance.push(
      `${line({
        type: "item/completed",
        item: {
          type: "collab_tool_call",
          tool: "closeagent",
          status: "completed",
          receiver_thread_ids: ["t1"],
        },
      })}\n`,
    );
    expect(JSON.stringify(later)).toContain("/a");
    expect(JSON.stringify(later)).toContain("shutdown");
  });

  it("does not emit when nothing changed", () => {
    const instance = parser();
    const payload = line({
      type: "item/completed",
      item: { type: "subagent_activity", agent_thread_id: "t1", kind: "running" },
    });
    instance.push(`${payload}\n`);
    expect(instance.push(`${payload}\n`)).toEqual([]);
  });
});
