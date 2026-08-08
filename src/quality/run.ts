import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec } from "../config/schema.js";
import { runProcess } from "../process/run.js";

export interface CommandResult {
  spec: CommandSpec;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface QualityReport {
  passed: boolean;
  commands: CommandResult[];
}

export async function runQualityCommands(
  cwd: string,
  commands: CommandSpec[],
  timeoutSeconds: number,
  artifactDirectory?: string,
  signal?: AbortSignal,
  options: { maxOutputBytes?: number } = {},
): Promise<QualityReport> {
  if (artifactDirectory) {
    await mkdir(artifactDirectory, { recursive: true });
  }
  const results: CommandResult[] = [];
  for (const [index, spec] of commands.entries()) {
    let process;
    try {
      process = await runProcess({
        command: spec.command,
        args: spec.args,
        cwd,
        timeoutMs: timeoutSeconds * 1_000,
        env: { ...processEnv(), CI: "true" },
        ...(signal ? { signal } : {}),
        ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
      });
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      process = {
        command: spec.command,
        args: spec.args,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: 0,
        timedOut: false,
        signal: null,
      };
    }
    const result: CommandResult = {
      spec,
      exitCode: process.exitCode,
      stdout: process.stdout,
      stderr: process.stderr,
      durationMs: process.durationMs,
      timedOut: process.timedOut,
      ...(process.stdoutBytes !== undefined ? { stdoutBytes: process.stdoutBytes } : {}),
      ...(process.stderrBytes !== undefined ? { stderrBytes: process.stderrBytes } : {}),
      ...(process.stdoutTruncated ? { stdoutTruncated: true } : {}),
      ...(process.stderrTruncated ? { stderrTruncated: true } : {}),
    };
    results.push(result);
    if (artifactDirectory) {
      const log = [
        `$ ${[spec.command, ...spec.args].join(" ")}`,
        `exit: ${String(result.exitCode)}`,
        `duration_ms: ${result.durationMs}`,
        `stdout_truncated: ${String(result.stdoutTruncated ?? false)}`,
        `stderr_truncated: ${String(result.stderrTruncated ?? false)}`,
        "",
        "--- stdout ---",
        result.stdout,
        "--- stderr ---",
        result.stderr,
      ].join("\n");
      await writeFile(path.join(artifactDirectory, `${index + 1}.log`), log, "utf8");
    }
    if (result.exitCode !== 0) {
      break;
    }
  }
  return { passed: results.length === commands.length && results.every((item) => item.exitCode === 0), commands: results };
}

function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export function deduplicateCommands(commands: CommandSpec[]): CommandSpec[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = JSON.stringify(command);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
