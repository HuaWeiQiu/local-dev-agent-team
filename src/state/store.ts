import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { RunState, RunStatus } from "./types.js";
import type { PendingRunEvent, RunEventSink } from "../events/types.js";
import { randomUUID } from "node:crypto";
import { traceIdForRun } from "../events/store.js";
import { parseRunState, runStateSchemaVersion } from "./schema.js";

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
    state.version ??= runStateSchemaVersion;
    if (state.history.length > maxRunHistoryEntries) {
      state.history = state.history.slice(-maxRunHistoryEntries);
    }
    const target = path.join(directory, "state.json");
    const temporary = `${target}.tmp`;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    // Self-healing queue: a failed save rejects its own caller but the chain
    // itself always settles, so one bad write cannot poison later saves.
    const result = this.saveQueue.catch(() => undefined).then(async () => {
      try {
        await mkdir(directory, { recursive: true });
        const handle = await open(temporary, "w");
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
        await syncDirectory(directory);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.saveQueue = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
    // The event fires only after the state is durable; a broken sink must not
    // fail the save or poison the write queue.
    try {
      this.emit(state.id, "run.updated", summarizeRun(state));
    } catch (error) {
      console.warn(
        `[state-store] failed to emit run.updated for '${state.id}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    let state: RunState;
    try {
      state = parseRunState(JSON.parse(contents));
    } catch (error) {
      throw new Error(
        `Run '${runId}' state.json is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    state.traceId ??= traceIdForRun(state.id);
    state.version ??= runStateSchemaVersion;
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

  /**
   * Discards `.deleting-*` directories left behind when the process died
   * between quarantine() and removeQuarantined(). Returns the number removed.
   */
  async discardQuarantineLeftovers(): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.runsDirectory, { withFileTypes: true });
    } catch {
      return 0;
    }
    let discarded = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".deleting-")) {
        continue;
      }
      try {
        await rm(path.join(this.runsDirectory, entry.name), { recursive: true, force: true });
        discarded += 1;
      } catch {
        // Leave undiscardable leftovers for the next sweep.
      }
    }
    return discarded;
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

/** Mirrors the directory-fsync discipline of src/evolution/persistence.ts. */
async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (
      process.platform === "win32" &&
      (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
