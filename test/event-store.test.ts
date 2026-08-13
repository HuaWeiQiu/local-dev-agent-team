import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("deletes a run event ledger and its idempotent command references together", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const store = new SqliteEventStore(path.join(root, "events.sqlite"));
    store.emit("run-clean", "run.updated", {});
    store.emit("run-keep", "run.updated", {});
    store.claimCommand("start-clean", "hash-a", { runId: "run-clean" });
    store.claimCommand("start-keep", "hash-b", { runId: "run-keep" });

    expect(store.deleteRun("run-clean")).toEqual({ events: 1, commands: 1 });
    expect(store.listAfter(0, "run-clean")).toEqual([]);
    expect(store.listAfter(0, "run-keep")).toHaveLength(1);
    expect(store.claimCommand("start-clean", "new-hash", { runId: "replacement" })).toMatchObject({
      claimed: true,
    });
    expect(store.claimCommand("start-keep", "hash-b", { runId: "other" })).toMatchObject({
      claimed: false,
      response: { runId: "run-keep" },
    });
    store.close();
  });

  it("matches claimed commands by run_id even when the response shape drifts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const databasePath = path.join(root, "events.sqlite");
    const store = new SqliteEventStore(databasePath);
    // Response carries extra fields, so a raw response_json match would miss.
    store.claimCommand("start-shaped", "hash-a", { runId: "run-shaped", extra: "drift" });
    // A legacy row claimed before the run_id column existed (run_id IS NULL).
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare(`
        INSERT INTO command_idempotency (key, request_hash, response_json, created_at, run_id)
        VALUES (?, ?, ?, ?, NULL)
      `)
      .run(
        "start-legacy",
        "hash-b",
        JSON.stringify({ runId: "run-legacy" }),
        new Date().toISOString(),
      );
    raw.close();

    expect(store.deleteRun("run-shaped")).toEqual({ events: 0, commands: 1 });
    expect(store.deleteRun("run-legacy")).toEqual({ events: 0, commands: 1 });
    store.close();
  });

  it("adds the run_id column to databases created before it existed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const databasePath = path.join(root, "events.sqlite");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE command_idempotency (
        key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    raw
      .prepare(`
        INSERT INTO command_idempotency (key, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        "start-old",
        "hash-old",
        JSON.stringify({ runId: "run-old" }),
        new Date().toISOString(),
      );
    raw.close();

    const store = new SqliteEventStore(databasePath);
    store.claimCommand("start-new", "hash-new", { runId: "run-new" });
    expect(store.deleteRun("run-new")).toEqual({ events: 0, commands: 1 });
    // Pre-migration rows still fall back to the JSON response match.
    expect(store.deleteRun("run-old")).toEqual({ events: 0, commands: 1 });
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
    let now = 1_000_000;
    const store = new SqliteEventStore(path.join(root, "events.sqlite"), {
      maxEventsPerRun: 2,
      now: () => now,
    });
    store.emit("run-a", "one", {});
    const second = store.emit("run-a", "two", {});
    const other = store.emit("run-b", "other", {});
    now += 6_000;
    const third = store.emit("run-a", "three", {});

    expect(store.listAfter(0, "run-a")).toEqual([second, third]);
    expect(store.listAfter(0, "run-b")).toEqual([other]);
    store.close();
  });

  it("throttles pruning during rapid appends and prunes again on close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    const databasePath = path.join(root, "events.sqlite");
    let now = 1_000_000;
    const store = new SqliteEventStore(databasePath, {
      maxEventsPerRun: 10,
      now: () => now,
    });
    for (let index = 0; index < 50; index += 1) {
      store.emit("run-hot", "agent.stdout", { index });
    }

    // Within the throttle window only the first append prunes, so the
    // high-frequency appends stay visible without paying a DELETE each time.
    expect(store.listAfter(0, "run-hot")).toHaveLength(50);
    store.close();

    const reopened = new SqliteEventStore(databasePath, { maxEventsPerRun: 10 });
    expect(reopened.listAfter(0, "run-hot")).toHaveLength(10);
    reopened.close();
  });

  it("prunes once the unpruned backlog crosses the pending threshold", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-events-"));
    let now = 1_000_000;
    const store = new SqliteEventStore(path.join(root, "events.sqlite"), {
      maxEventsPerRun: 10,
      now: () => now,
    });
    for (let index = 0; index < 250; index += 1) {
      store.emit("run-bulk", "agent.stdout", { index });
    }

    const retained = store.listAfter(0, "run-bulk");
    expect(retained.length).toBeLessThan(250);
    expect(retained.at(-1)?.payload).toEqual({ index: 249 });
    store.close();

    const reopened = new SqliteEventStore(path.join(root, "events.sqlite"), {
      maxEventsPerRun: 10,
    });
    expect(reopened.listAfter(0, "run-bulk")).toHaveLength(10);
    reopened.close();
  });
});
