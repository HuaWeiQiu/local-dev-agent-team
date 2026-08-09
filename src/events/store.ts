import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PendingRunEvent, RunEvent, RunEventSink } from "./types.js";

interface EventRow {
  sequence: number;
  event_id: string;
  schema_version: number;
  run_id: string;
  type: string;
  occurred_at: string;
  payload_json: string;
}

interface CommandRow {
  request_hash: string;
  response_json: string;
}

export interface CommandClaim {
  claimed: boolean;
  response: unknown;
}

export class SqliteEventStore implements RunEventSink {
  private readonly database: DatabaseSync;
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(
    databasePath: string,
    private readonly options: { maxEventsPerRun?: number } = {},
  ) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_run_sequence
        ON run_events(run_id, sequence);
      CREATE TABLE IF NOT EXISTS command_idempotency (
        key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  append(event: PendingRunEvent): RunEvent {
    const payloadJson = JSON.stringify(event.payload);
    if (payloadJson === undefined) {
      throw new Error(`Event '${event.type}' payload is not JSON serializable`);
    }
    const result = this.database
      .prepare(`
        INSERT INTO run_events (
          event_id, schema_version, run_id, type, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.schemaVersion,
        event.runId,
        event.type,
        event.occurredAt,
        payloadJson,
      );
    const stored: RunEvent = {
      ...event,
      traceId: traceIdForRun(event.runId),
      spanId: spanIdForEvent(event.id),
      sequence: Number(result.lastInsertRowid),
    };
    this.pruneRunEvents(event.runId);
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return stored;
  }

  emit(runId: string, type: string, payload: unknown): RunEvent {
    return this.append({
      id: randomUUID(),
      schemaVersion: 1,
      runId,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }

  listAfter(sequence: number, runId?: string, limit = 1_000): RunEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 10_000));
    const rows = runId
      ? (this.database
          .prepare(`
            SELECT sequence, event_id, schema_version, run_id, type, occurred_at, payload_json
            FROM run_events
            WHERE sequence > ? AND run_id = ?
            ORDER BY sequence ASC
            LIMIT ?
          `)
          .all(sequence, runId, boundedLimit) as unknown as EventRow[])
      : (this.database
          .prepare(`
            SELECT sequence, event_id, schema_version, run_id, type, occurred_at, payload_json
            FROM run_events
            WHERE sequence > ?
            ORDER BY sequence ASC
            LIMIT ?
          `)
          .all(sequence, boundedLimit) as unknown as EventRow[]);
    return rows.map(decodeEvent);
  }

  subscribe(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  claimCommand(key: string, requestHash: string, response: unknown): CommandClaim {
    if (!key.trim()) {
      throw new Error("Idempotency key cannot be empty");
    }
    const responseJson = JSON.stringify(response);
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO command_idempotency (
          key, request_hash, response_json, created_at
        ) VALUES (?, ?, ?, ?)
      `)
      .run(key, requestHash, responseJson, new Date().toISOString());
    if (result.changes === 1) {
      return { claimed: true, response };
    }
    const existing = this.database
      .prepare(`
        SELECT request_hash, response_json
        FROM command_idempotency
        WHERE key = ?
      `)
      .get(key) as unknown as CommandRow | undefined;
    if (!existing) {
      throw new Error(`Idempotency record '${key}' disappeared`);
    }
    if (existing.request_hash !== requestHash) {
      throw new Error(`Idempotency key '${key}' was already used for another request`);
    }
    return { claimed: false, response: JSON.parse(existing.response_json) as unknown };
  }

  releaseCommand(key: string, requestHash: string): void {
    this.database
      .prepare("DELETE FROM command_idempotency WHERE key = ? AND request_hash = ?")
      .run(key, requestHash);
  }

  deleteRun(runId: string): { events: number; commands: number } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const events = Number(
        this.database.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId).changes,
      );
      const commands = Number(
        this.database
          .prepare("DELETE FROM command_idempotency WHERE response_json = ?")
          .run(JSON.stringify({ runId })).changes,
      );
      this.database.exec("COMMIT");
      return { events, commands };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.listeners.clear();
    this.database.close();
  }

  private pruneRunEvents(runId: string): void {
    const limit = this.options.maxEventsPerRun;
    if (!limit) return;
    this.database
      .prepare(`
        DELETE FROM run_events
        WHERE run_id = ?
          AND sequence NOT IN (
            SELECT sequence
            FROM run_events
            WHERE run_id = ?
            ORDER BY sequence DESC
            LIMIT ?
          )
      `)
      .run(runId, runId, limit);
  }
}

function decodeEvent(row: EventRow): RunEvent {
  if (row.schema_version !== 1) {
    throw new Error(`Unsupported event schema version '${row.schema_version}'`);
  }
  return {
    sequence: row.sequence,
    id: row.event_id,
    schemaVersion: 1,
    runId: row.run_id,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as unknown,
    traceId: traceIdForRun(row.run_id),
    spanId: spanIdForEvent(row.event_id),
  };
}

export function traceIdForRun(runId: string): string {
  return createHash("sha256").update(`agent-team:trace:${runId}`).digest("hex").slice(0, 32);
}

function spanIdForEvent(eventId: string): string {
  return createHash("sha256").update(`agent-team:span:${eventId}`).digest("hex").slice(0, 16);
}
