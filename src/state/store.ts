import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunState, RunStatus } from "./types.js";
import type { PendingRunEvent, RunEventSink } from "../events/types.js";
import { randomUUID } from "node:crypto";
import { traceIdForRun } from "../events/store.js";

export class RunStateStore {
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly runsDirectory: string,
    private readonly eventSink?: RunEventSink,
  ) {}

  runDirectory(runId: string): string {
    return path.join(this.runsDirectory, runId);
  }

  artifactDirectory(runId: string, ...parts: string[]): string {
    return path.join(this.runDirectory(runId), "artifacts", ...parts);
  }

  async save(state: RunState): Promise<void> {
    const directory = this.runDirectory(state.id);
    state.updatedAt = new Date().toISOString();
    const target = path.join(directory, "state.json");
    const temporary = `${target}.tmp`;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    this.saveQueue = this.saveQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, serialized, "utf8");
      await rename(temporary, target);
      this.emit(state.id, "run.updated", summarizeRun(state));
    });
    await this.saveQueue;
  }

  emit(runId: string, type: string, payload: unknown): void {
    const event: PendingRunEvent = {
      id: randomUUID(),
      schemaVersion: 1,
      runId,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    };
    this.eventSink?.append(event);
  }

  async transition(state: RunState, status: RunStatus, message: string): Promise<void> {
    state.status = status;
    state.history.push({ at: new Date().toISOString(), status, message });
    await this.save(state);
  }

  async load(runId: string): Promise<RunState> {
    const contents = await readFile(path.join(this.runDirectory(runId), "state.json"), "utf8");
    const state = JSON.parse(contents) as RunState;
    state.traceId ??= traceIdForRun(state.id);
    return state;
  }

  async list(): Promise<RunState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDirectory);
    } catch {
      return [];
    }
    const states = await Promise.all(
      entries.map(async (entry) => {
        try {
          return await this.load(entry);
        } catch {
          return undefined;
        }
      }),
    );
    return states
      .filter((state): state is RunState => state !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

export function summarizeRun(state: RunState): import("./types.js").RunSummary {
  const taskCounts: import("./types.js").RunSummary["taskCounts"] = {
    pending: 0,
    working: 0,
    reworking: 0,
    passed: 0,
    merged: 0,
    blocked: 0,
  };
  for (const task of state.tasks) {
    taskCounts[task.status] += 1;
  }
  return {
    id: state.id,
    goal: state.goal,
    status: state.status,
    strategy: state.strategy?.name ?? "legacy",
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    taskCounts,
    ...(state.error ? { error: state.error } : {}),
  };
}
