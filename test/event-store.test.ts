import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/store.js";

describe("SQLite event store", () => {
  it("persists ordered events and filters by run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const store = new SqliteEventStore(path.join(root, "events.sqlite"));
    const observed: number[] = [];
    const unsubscribe = store.subscribe((event) => observed.push(event.sequence));

    const first = store.emit("run-a", "run.created", { value: 1 });
    const second = store.emit("run-b", "run.created", { value: 2 });
    const third = store.emit("run-a", "run.updated", { value: 3 });

    expect(store.listAfter(first.sequence, "run-a")).toEqual([third]);
    expect(observed).toEqual([first.sequence, second.sequence, third.sequence]);
    unsubscribe();
    store.close();

    const reopened = new SqliteEventStore(path.join(root, "events.sqlite"));
    expect(reopened.listAfter(0, "run-a")).toEqual([first, third]);
    reopened.close();
  });

  it("deduplicates matching commands and rejects key reuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const store = new SqliteEventStore(path.join(root, "events.sqlite"));

    expect(store.claimCommand("request-1", "hash-a", { runId: "one" })).toEqual({
      claimed: true,
      response: { runId: "one" },
    });
    expect(store.claimCommand("request-1", "hash-a", { runId: "two" })).toEqual({
      claimed: false,
      response: { runId: "one" },
    });
    expect(() =>
      store.claimCommand("request-1", "hash-b", { runId: "two" }),
    ).toThrow("already used for another request");
    store.close();
  });

  it("rejects non-JSON event payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const store = new SqliteEventStore(path.join(root, "events.sqlite"));
    expect(() => store.emit("run-a", "invalid", undefined)).toThrow(
      "payload is not JSON serializable",
    );
    store.close();
  });

  it("isolates a failed live subscriber from durable event appends", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const store = new SqliteEventStore(path.join(root, "events.sqlite"));
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
      throw new Error("disconnected client");
    });

    const first = store.emit("run-a", "run.updated", { value: 1 });
    const second = store.emit("run-a", "run.updated", { value: 2 });

    expect(calls).toBe(1);
    expect(store.listAfter(0, "run-a")).toEqual([first, second]);
    store.close();
  });

  it("retains only the configured number of events per run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const store = new SqliteEventStore(path.join(root, "events.sqlite"), {
      maxEventsPerRun: 2,
    });
    store.emit("run-a", "one", {});
    const second = store.emit("run-a", "two", {});
    const other = store.emit("run-b", "other", {});
    const third = store.emit("run-a", "three", {});

    expect(store.listAfter(0, "run-a")).toEqual([second, third]);
    expect(store.listAfter(0, "run-b")).toEqual([other]);
    store.close();
  });
});
