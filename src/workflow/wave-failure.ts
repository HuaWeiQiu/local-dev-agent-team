import { loadavg } from "node:os";
import { runProcess } from "../process/run.js";

/**
 * Where a task stood when its wave sibling died. The order is the order the
 * scheduler does the work, so a rejection names the step it never got past.
 */
export type WaveTaskPhase = "worktree" | "dependencies" | "task";

/** Mutable marker a wave task keeps up to date while it runs. */
export interface WaveTaskProgress {
  phase: WaveTaskPhase;
}

/** One task that failed while the rest of its wave was still running. */
export interface WaveRejectionFacts {
  taskId: string;
  phase: WaveTaskPhase;
  status: string;
  attempts: number;
  durationMs: number;
  error: string;
}

/**
 * What else was running on the machine. A wave that dies only under load cannot
 * be explained by the run alone, so the run records the load it saw.
 */
export interface WaveEnvironmentFacts {
  loadAverage: number[];
  /** Processes that look like a test or quality run, or null when `ps` failed. */
  competingProcesses: number | null;
}

const COMPETING_PROCESS_PATTERN = /vitest|crapper/;
const ERROR_MAX_CHARS = 500;

export function waveTaskProgress(): WaveTaskProgress {
  return { phase: "worktree" };
}

/** The facts a reader needs when a sibling died: where, when, and what it said. */
export function waveRejectionFacts(input: {
  taskId: string;
  progress: WaveTaskProgress;
  task: { status: string; attempts: number };
  durationMs: number;
  error: unknown;
}): WaveRejectionFacts {
  return {
    taskId: input.taskId,
    phase: input.progress.phase,
    status: input.task.status,
    attempts: input.task.attempts,
    durationMs: input.durationMs,
    error: messageOf(input.error).slice(0, ERROR_MAX_CHARS),
  };
}

/** Sample the machine, best effort: a diagnostic never fails the wave it describes. */
export async function sampleWaveEnvironment(cwd: string): Promise<WaveEnvironmentFacts> {
  return {
    loadAverage: loadavg().map((value) => Number(value.toFixed(2))),
    competingProcesses: await countCompetingProcesses(cwd),
  };
}

async function countCompetingProcesses(cwd: string): Promise<number | null> {
  try {
    const result = await runProcess({
      command: "ps",
      args: ["-Ao", "command"],
      cwd,
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return result.stdout
      .split("\n")
      .filter((line) => COMPETING_PROCESS_PATTERN.test(line))
      .filter((line) => !line.startsWith("ps -Ao command")).length;
  } catch {
    return null;
  }
}

/** The `run.wave.completed` payload, extended with facts only when there is a failure. */
export function waveCompletionPayload(input: {
  taskIds: string[];
  concurrency: number;
  status: string;
  batchKeys: string[];
  error?: string;
  blockedTaskId?: string;
  rejected?: WaveRejectionFacts[];
  environment?: WaveEnvironmentFacts;
}): Record<string, unknown> {
  return {
    taskIds: input.taskIds,
    concurrency: input.concurrency,
    status: input.status,
    batchKeys: input.batchKeys,
    ...(input.error ? { error: input.error } : {}),
    ...(input.blockedTaskId ? { blockedTaskId: input.blockedTaskId } : {}),
    ...(input.rejected?.length ? { rejected: input.rejected } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
