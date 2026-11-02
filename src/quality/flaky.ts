import path from "node:path";
import type { CommandSpec } from "../config/schema.js";
import { runQualityCommands, type CommandResult, type QualityReport } from "./run.js";

/**
 * Runs the quality commands and, when one fails, reruns from the failing
 * command before reporting a failure. A command that passes on rerun is
 * recorded as flaky instead of forcing a model rework for a nondeterministic
 * test. The report is still produced by commands alone, never by a model, and
 * timeouts are not rerun because they cost the most and flake the least.
 */
interface RerunState {
  kept: CommandResult[];
  flaky: CommandSpec[];
  attempts: number;
}

interface RerunContext {
  cwd: string;
  commands: CommandSpec[];
  timeoutSeconds: number;
  artifactDirectory: string | undefined;
  signal: AbortSignal | undefined;
  options: { maxOutputBytes?: number };
}

function rerunArtifactDirectory(
  artifactDirectory: string | undefined,
  attempt: number,
): string | undefined {
  return artifactDirectory ? path.join(artifactDirectory, `rerun-${attempt}`) : undefined;
}

/**
 * Reruns from the first failing command once. Returns false when the rerun
 * settled the question (passed) or when the failure must not be retried.
 */
async function rerunAttempt(status: RerunState, context: RerunContext): Promise<boolean> {
  const failedAt = status.kept.findIndex((result) => result.exitCode !== 0);
  const failed = status.kept[failedAt];
  if (!failed || failed.timedOut) return false;
  status.attempts += 1;
  const rerun = await runQualityCommands(
    context.cwd,
    context.commands.slice(failedAt),
    context.timeoutSeconds,
    rerunArtifactDirectory(context.artifactDirectory, status.attempts),
    context.signal,
    context.options,
  );
  status.kept = [...status.kept.slice(0, failedAt), ...rerun.commands];
  if (rerun.commands[0]?.exitCode === 0) status.flaky.push(failed.spec);
  return !rerun.passed;
}

async function rerunUntilStable(
  status: RerunState,
  context: RerunContext,
  reruns: number,
): Promise<RerunState> {
  while (status.attempts < reruns) {
    if (!(await rerunAttempt(status, context))) break;
  }
  return status;
}

function summarize(commands: CommandSpec[], status: RerunState): QualityReport {
  return {
    passed:
      status.kept.length === commands.length &&
      status.kept.every((result) => result.exitCode === 0),
    commands: status.kept,
    ...(status.flaky.length > 0 ? { flaky: status.flaky } : {}),
    reruns: status.attempts,
  };
}

export async function runQualityWithRerun(
  cwd: string,
  commands: CommandSpec[],
  timeoutSeconds: number,
  artifactDirectory: string | undefined,
  signal: AbortSignal | undefined,
  options: { maxOutputBytes?: number },
  reruns: number,
): Promise<QualityReport> {
  const report = await runQualityCommands(cwd, commands, timeoutSeconds, artifactDirectory, signal, options);
  if (report.passed || reruns <= 0) return report;
  const status = await rerunUntilStable(
    { kept: report.commands, flaky: [], attempts: 0 },
    { cwd, commands, timeoutSeconds, artifactDirectory, signal, options },
    reruns,
  );
  return summarize(commands, status);
}
