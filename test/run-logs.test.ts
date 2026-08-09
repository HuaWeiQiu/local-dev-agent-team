import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/store.js";
import { filterRunEvents, lifecycleDetail, renderLogLines } from "../src/logs/render.js";
import type { RunEvent } from "../src/events/types.js";

describe("SqliteEventStore.listRunEvents", () => {
  it("lists all events of one run in append order without touching other runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-logs-"));
    const store = new SqliteEventStore(path.join(root, "control.sqlite"));

    store.emit("run-b", "run.queued", { goal: "other goal" });
    const queued = store.emit("run-a", "run.queued", { goal: "demo goal", strategy: "legacy" });
    const stdout = store.emit("run-a", "agent.stdout", {
      role: "architect",
      profile: "claude-code",
      artifactKey: "plan",
      chunk: "hello\n",
    });
    const stderr = store.emit("run-a", "agent.stderr", {
      role: "architect",
      profile: "claude-code",
      artifactKey: "plan",
      chunk: "warning\n",
    });
    const updated = store.emit("run-a", "run.updated", { status: "succeeded" });

    const events = store.listRunEvents("run-a");
    expect(events).toEqual([queued, stdout, stderr, updated]);
    expect(events.map((event) => event.sequence)).toEqual([
      queued.sequence,
      stdout.sequence,
      stderr.sequence,
      updated.sequence,
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "run.queued",
      "agent.stdout",
      "agent.stderr",
      "run.updated",
    ]);
    expect(events[1]?.payload).toEqual({
      role: "architect",
      profile: "claude-code",
      artifactKey: "plan",
      chunk: "hello\n",
    });
    expect(store.listRunEvents("run-missing")).toEqual([]);
    store.close();

    const reopened = new SqliteEventStore(path.join(root, "control.sqlite"));
    expect(reopened.listRunEvents("run-a")).toHaveLength(4);
    expect(reopened.listRunEvents("run-b")).toHaveLength(1);
    reopened.close();
  });
});

function makeEvent(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    schemaVersion: 1,
    runId: "run-a",
    type,
    occurredAt: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload,
    traceId: "trace",
    spanId: `span-${sequence}`,
  };
}

const sampleEvents: RunEvent[] = [
  makeEvent(1, "run.queued", { goal: "demo", strategy: "legacy" }),
  makeEvent(2, "agent.stdout", { role: "planner", chunk: "plan first\n" }),
  makeEvent(3, "agent.stderr", { role: "worker", chunk: "compiling\n" }),
  makeEvent(4, "agent.stdout", { role: "worker", chunk: "done\n" }),
  makeEvent(5, "agent.invocation.completed", { role: "worker", success: true }),
  makeEvent(6, "run.updated", { status: "succeeded" }),
];

describe("run log filters", () => {
  it("keeps all events when no filter is set", () => {
    expect(filterRunEvents(sampleEvents, {})).toEqual(sampleEvents);
  });

  it("filters by role from the event payload", () => {
    expect(filterRunEvents(sampleEvents, { role: "worker" }).map((event) => event.sequence)).toEqual([
      3, 4, 5,
    ]);
    expect(filterRunEvents(sampleEvents, { role: "missing" })).toEqual([]);
  });

  it("filters by event type prefix", () => {
    expect(
      filterRunEvents(sampleEvents, { typePrefix: "agent.stdout" }).map((event) => event.type),
    ).toEqual(["agent.stdout", "agent.stdout"]);
    expect(filterRunEvents(sampleEvents, { typePrefix: "run." }).map((event) => event.sequence)).toEqual([
      1, 6,
    ]);
  });

  it("keeps only the last n events with tail", () => {
    expect(filterRunEvents(sampleEvents, { tail: 2 }).map((event) => event.sequence)).toEqual([5, 6]);
    expect(filterRunEvents(sampleEvents, { tail: 100 })).toEqual(sampleEvents);
    expect(filterRunEvents(sampleEvents, { tail: 0 })).toEqual([]);
  });

  it("applies role and type before tail", () => {
    expect(
      filterRunEvents(sampleEvents, { role: "worker", typePrefix: "agent.", tail: 2 }).map(
        (event) => event.sequence,
      ),
    ).toEqual([4, 5]);
  });
});

describe("run log rendering", () => {
  it("renders stream chunks with a role prefix, one line per chunk line", () => {
    const lines = renderLogLines([
      makeEvent(1, "agent.stdout", { role: "planner", chunk: "line one\nline two\n" }),
      makeEvent(2, "agent.stderr", { role: "worker", chunk: "boom" }),
    ]);
    expect(lines).toEqual([
      "[planner stdout] line one",
      "[planner stdout] line two",
      "[worker stderr] boom",
    ]);
  });

  it("renders lifecycle events as one summarized line", () => {
    const lines = renderLogLines([
      makeEvent(1, "run.queued", { goal: "demo goal", strategy: "legacy" }),
      makeEvent(2, "run.crashed", { error: "adapter failed" }),
      makeEvent(3, "run.cancel-requested", {}),
    ]);
    expect(lines).toEqual([
      "[run.queued] goal=demo goal strategy=legacy",
      "[run.crashed] error=adapter failed",
      "[run.cancel-requested]",
    ]);
  });

  it("flattens and truncates long detail values", () => {
    const longGoal = "word ".repeat(100).trim();
    const detail = lifecycleDetail({ goal: longGoal });
    expect(detail.length).toBeLessThanOrEqual(240);
    expect(detail.startsWith("goal=word word")).toBe(true);
    expect(detail.endsWith("...")).toBe(true);
  });

  it("summarizes nested payload values as compact JSON", () => {
    expect(lifecycleDetail({ checkpoint: { id: "cp-1", stage: "plan" } })).toBe(
      'checkpoint={"id":"cp-1","stage":"plan"}',
    );
  });

  it("ignores empty stream chunks", () => {
    expect(renderLogLines([makeEvent(1, "agent.stdout", { role: "planner", chunk: "" })])).toEqual(
      [],
    );
  });
});
