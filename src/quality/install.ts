import { existsSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../process/run.js";
import { sanitizedChildEnv } from "../process/env.js";
import type { CommandResult } from "./run.js";

export interface WorktreeInstallOptions {
  timeoutSeconds: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Test seam. Production always uses pnpm install --frozen-lockfile. */
  installer?: { command: string; args: string[] };
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"] as const;

export function needsWorktreeInstall(cwd: string): boolean {
  if (!existsSync(path.join(cwd, "package.json")) || existsSync(path.join(cwd, "node_modules"))) {
    return false;
  }
  // No lockfile: skip. Frozen install would fail or write a new lockfile and
  // dirty the isolated worktree (that then fails checkpoint resume).
  return LOCKFILES.some((name) => existsSync(path.join(cwd, name)));
}

/**
 * Isolated Git worktrees do not inherit node_modules. Quality gates that call
 * `tsc` / `pnpm check` then fail with a false "task" error. Install before any
 * quality command when the worktree has a package.json and no node_modules.
 */
export async function ensureWorktreeNodeModules(
  cwd: string,
  options: WorktreeInstallOptions,
): Promise<CommandResult | undefined> {
  if (!needsWorktreeInstall(cwd)) {
    return undefined;
  }
  const installer = options.installer ?? { command: "pnpm", args: ["install", "--frozen-lockfile"] };
  let process;
  try {
    process = await runProcess({
      command: installer.command,
      args: installer.args,
      cwd,
      timeoutMs: options.timeoutSeconds * 1_000,
      env: { ...sanitizedChildEnv(), CI: "true" },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });
    options.signal?.throwIfAborted();
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    process = {
      command: installer.command,
      args: installer.args,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      timedOut: false,
      signal: null,
    };
  }
  const result: CommandResult = {
    spec: installer,
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
  if (result.exitCode !== 0) {
    throw new Error(formatInstallFailure(cwd, result));
  }
  return result;
}

export function formatQualityFailure(prefix: string, report: { commands: CommandResult[] }): string {
  const failed = report.commands.find((command) => command.exitCode !== 0);
  const detail = [failed?.stderr, failed?.stdout]
    .filter((chunk): chunk is string => Boolean(chunk?.trim()))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) {
    return prefix;
  }
  return `${prefix}: ${detail.slice(0, 400)}`;
}

function formatInstallFailure(cwd: string, result: CommandResult): string {
  const detail = [result.stderr, result.stdout]
    .filter((chunk) => chunk.trim())
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  const location = path.basename(cwd);
  const suffix = detail ? `: ${detail.slice(0, 360)}` : "";
  return `Worktree dependency install failed (${location}): node_modules missing; pnpm install --frozen-lockfile exited ${String(result.exitCode)}${suffix}`;
}
