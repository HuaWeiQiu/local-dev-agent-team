import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunState, RunStatus } from "./types.js";
import type { PendingRunEvent, RunEventSink } from "../events/types.js";
import { randomUUID } from "node:crypto";
import { traceIdForRun } from "../events/store.js";

export const maxRunHistoryEntries = 500;

export class RunStateStore {
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly runsDirectory: string,
    private readonly eventSink?: RunEventSink,
  ) {}

  runDirectory(runId: string): string {
    assertRunId(runId);
    return path.join(this.runsDirectory, runId);
  }

  artifactDirectory(runId: string, ...parts: string[]): string {
    const root = path.resolve(this.runDirectory(runId), "artifacts");
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Artifact path must stay inside run '${runId}'`);
    }
    return target;
  }

  async save(state: RunState): Promise<void> {
    const directory = this.runDirectory(state.id);
    state.updatedAt = new Date().toISOString();
    if (state.history.length > maxRunHistoryEntries) {
      state.history = state.history.slice(-maxRunHistoryEntries);
    }
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

  async quarantine(runId: string): Promise<{ original: string; quarantined: string }> {
    await this.saveQueue;
    const original = this.runDirectory(runId);
    const quarantined = path.join(
      this.runsDirectory,
      `.deleting-${runId}-${randomUUID()}`,
    );
    await rename(original, quarantined);
    return { original, quarantined };
  }

  async restoreQuarantined(paths: { original: string; quarantined: string }): Promise<void> {
    await rename(paths.quarantined, paths.original);
  }

  async removeQuarantined(paths: { quarantined: string }): Promise<void> {
    await rm(paths.quarantined, { recursive: true, force: true });
  }
}

export function assertRunId(runId: string): void {
  if (
    runId.length === 0 ||
    runId.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
    runId === "." ||
    runId === ".."
  ) {
    throw new Error(`Invalid run ID '${runId}'`);
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
