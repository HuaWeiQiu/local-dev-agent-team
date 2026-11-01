/**
 * Telling "moving" apart from "getting anywhere".
 *
 * A liveness probe answers whether a process is alive. It cannot answer the
 * question that actually costs a person an afternoon: is this run still making
 * progress, or has it been turning in place for twenty minutes? The article behind
 * ADR 0020 puts it plainly — a worker that keeps producing tokens and never
 * changes the work is the failure that monitoring misses.
 *
 * Nothing here calls a model. The signals are what a run already records, compared
 * across samples: a new task, a new attempt, a longer history, a bigger artifact,
 * a different status. Activity timestamps alone are deliberately *not* progress —
 * they are exactly what a spinning run keeps updating.
 */

export type WatchVerdict = "insufficient" | "progressing" | "waiting" | "stalled";

/** One observation of a run, at a moment in time. */
export interface WatchSample {
  at: number;
  status: string;
  taskId: string | undefined;
  /** Attempts on the current task: a retry is progress even without new output. */
  attempts: number;
  /** Bytes the run has produced so far. */
  artifactBytes: number;
  /** How many history entries the run has. */
  historyLength: number;
}

export interface WatchOptions {
  /** How quiet a run may be before "waiting" becomes "stalled". */
  stallAfterMs?: number;
  /** How many samples must agree before calling it stalled. */
  samplesToStall?: number;
}

export const DEFAULT_STALL_AFTER_MS = 15 * 60_000;
/** Samples taken after the last change before the quiet duration is believed. */
export const DEFAULT_SAMPLES_TO_STALL = 2;

/**
 * Judge the tail of a run's samples.
 *
 * Late binding on purpose: the caller keeps the history and passes what it has, so
 * a restart does not have to reconstruct anything.
 */
export function progressVerdict(
  samples: readonly WatchSample[],
  options: WatchOptions = {},
): WatchVerdict {
  const stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const samplesToStall = options.samplesToStall ?? DEFAULT_SAMPLES_TO_STALL;
  if (samples.length < 2) return "insufficient";

  const latest = samples.at(-1)!;
  // The reading itself moved: something happened since the previous look.
  if (changed(samples.at(-2)!, latest)) return "progressing";
  const quietMs = latest.at - latestQuietSince(samples);
  // Quiet, but not for long enough to call it stuck: a slow step looks like this.
  if (quietMs < stallAfterMs) return "waiting";
  // Quiet for longer than the window, but too few samples have seen it yet.
  return samplesSinceProgress(samples) >= samplesToStall ? "stalled" : "waiting";
}

/** The timestamp of the last sample that differed from the one before it. */
export function latestQuietSince(samples: readonly WatchSample[]): number {
  for (let index = samples.length - 1; index > 0; index -= 1) {
    if (changed(samples[index - 1]!, samples[index]!)) return samples[index]!.at;
  }
  return samples[0]!.at;
}

/**
 * How many samples came after the last change. Two means "the change, then two
 * quiet readings": enough to tell a slow step from a stuck one.
 */
export function samplesSinceProgress(samples: readonly WatchSample[]): number {
  if (samples.length === 0) return 0;
  for (let index = samples.length - 1; index > 0; index -= 1) {
    if (changed(samples[index - 1]!, samples[index]!)) return samples.length - 1 - index;
  }
  return samples.length - 1;
}

/**
 * Whether anything the run *did* changed. `at` is excluded on purpose: a run that
 * keeps being sampled is talking, not working.
 */
export function changed(previous: WatchSample, current: WatchSample): boolean {
  return (
    previous.status !== current.status
    || previous.taskId !== current.taskId
    || previous.attempts !== current.attempts
    || previous.artifactBytes !== current.artifactBytes
    || previous.historyLength !== current.historyLength
  );
}

/** The line a person reads, or nothing when there is nothing to say. */
export function describeVerdict(verdict: WatchVerdict, quietMs: number): string {
  const minutes = Math.max(1, Math.round(quietMs / 60_000));
  switch (verdict) {
    case "stalled":
      return `已经 ${minutes} 分钟没有任何实质进展`;
    case "waiting":
      return `静默 ${minutes} 分钟，仍在等待`;
    case "progressing":
      return "正在推进";
    case "insufficient":
      return "样本不足，暂不判断";
  }
}

/** Where the watchdog reads from: the runs it should look at, and their states. */
export interface WatchSource {
  liveRuns(): Promise<string[]>;
  sample(runId: string): Promise<WatchSample | undefined>;
}

export interface WatchFinding {
  runId: string;
  verdict: WatchVerdict;
  quietMs: number;
  detail: string;
}

export interface WatchdogOptions {
  /** How many samples to keep per run; older ones never change a verdict. */
  historyLimit?: number;
  stallAfterMs?: number;
  samplesToStall?: number;
}

export const DEFAULT_HISTORY_LIMIT = 8;

/**
 * Samples the live runs on a tick and reports the ones that stopped making
 * progress.
 *
 * There is no timer in the judgement: `tick` is one look, and `start` is only a
 * way to call it on an interval. That keeps the behaviour testable without
 * sleeping, and keeps the interval's lifetime explicit.
 */
export class Watchdog {
  readonly #history = new Map<string, WatchSample[]>();
  /** Runs already reported as stalled, so one episode is one message. */
  readonly #reported = new Set<string>();
  readonly #options: Required<WatchdogOptions>;

  constructor(
    private readonly source: WatchSource,
    private readonly onFinding: (finding: WatchFinding) => void | Promise<void>,
    options: WatchdogOptions = {},
  ) {
    this.#options = {
      historyLimit: options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
      stallAfterMs: options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS,
      samplesToStall: options.samplesToStall ?? DEFAULT_SAMPLES_TO_STALL,
    };
  }

  /** One look at every live run: records a sample and returns what it found. */
  async tick(): Promise<WatchFinding[]> {
    const findings: WatchFinding[] = [];
    for (const runId of await this.source.liveRuns()) {
      const sample = await this.source.sample(runId);
      if (!sample) continue;
      const history = this.#record(runId, sample);
      const verdict = progressVerdict(history, this.#options);
      // One message per stall: a run reported once stays reported until it moves
      // again, otherwise every tick would repeat the same alarm.
      if (verdict !== "stalled") {
        this.#reported.delete(runId);
        continue;
      }
      if (this.#reported.has(runId)) continue;
      this.#reported.add(runId);
      const finding: WatchFinding = {
        runId,
        verdict,
        quietMs: sample.at - latestQuietSince(history),
        detail: describeVerdict(verdict, sample.at - latestQuietSince(history)),
      };
      findings.push(finding);
      await this.onFinding(finding);
    }
    return findings;
  }

  /** Samples this run has, oldest first. Kept for the caller's inspection. */
  samples(runId: string): readonly WatchSample[] {
    return this.#history.get(runId) ?? [];
  }

  /** Forget a run: it ended, or the caller no longer cares. */
  forget(runId: string): void {
    this.#history.delete(runId);
    this.#reported.delete(runId);
  }

  /**
   * Call `tick` every `intervalMs`. The timer is unref'd so a watchdog can never
   * be the reason a process stays alive.
   */
  start(intervalMs: number): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  #record(runId: string, sample: WatchSample): WatchSample[] {
    const history = [...(this.#history.get(runId) ?? []), sample].slice(-this.#options.historyLimit);
    this.#history.set(runId, history);
    return history;
  }
}

/** The sample a run's own record produces. Pure, so it cannot drift from state. */
export function sampleRun(
  run: { status: string; tasks: { task: { id: string }; status: string; attempts: number }[]; history: unknown[]; usage?: { artifactBytes?: number } },
  at: number,
): WatchSample {
  const working = run.tasks.find((task) => task.status === "working" || task.status === "reworking");
  return {
    at,
    status: run.status,
    taskId: working?.task.id,
    attempts: working?.attempts ?? 0,
    artifactBytes: run.usage?.artifactBytes ?? 0,
    historyLength: run.history.length,
  };
}

