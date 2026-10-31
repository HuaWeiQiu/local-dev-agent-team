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

  const flaky: CommandSpec[] = [];
  let kept: CommandResult[] = report.commands;
  let attempts = 0;
  while (attempts < reruns) {
    const failedAt = kept.findIndex((result) => result.exitCode !== 0);
    const failed = kept[failedAt];
    if (!failed || failed.timedOut) break;
    attempts += 1;
    const rerun = await runQualityCommands(
      cwd,
      commands.slice(failedAt),
      timeoutSeconds,
      artifactDirectory ? path.join(artifactDirectory, `rerun-${attempts}`) : undefined,
      signal,
      options,
    );
    kept = [...kept.slice(0, failedAt), ...rerun.commands];
    if (rerun.commands[0]?.exitCode === 0) flaky.push(failed.spec);
    if (rerun.passed) break;
  }
  return {
    passed: kept.length === commands.length && kept.every((result) => result.exitCode === 0),
    commands: kept,
    ...(flaky.length > 0 ? { flaky } : {}),
    reruns: attempts,
  };
}
