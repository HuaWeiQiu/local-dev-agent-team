/**
 * Pure option handling for the `agent-team` command surface.
 *
 * These helpers used to live inside `cli.ts`, where the module runs
 * `program.parseAsync()` on import: nothing could call them without launching
 * the CLI, so no test reached them and every branch was unpaid debt. They hold
 * no state and print nothing but their own report, which is exactly what a
 * command-line parser should be.
 */
import { createInterface } from "node:readline/promises";
import type { RepairPushSummary } from "../github/repair.js";

export function parseProfileAssignments(assignments: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0 || separator === assignment.length - 1) {
      throw new Error(`Invalid profile assignment '${assignment}'; expected role=profile`);
    }
    result[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return result;
}

export function parseTemplateOption(value: string): "auto" | "quick" | "standard" | "full" {
  if (value === "auto" || value === "quick" || value === "standard" || value === "full") return value;
  throw new Error(`Unknown workflow template '${value}'; use auto, quick, standard or full`);
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function printChecks(checks: Array<{ bucket: string; name: string; state: string }>): void {
  if (checks.length === 0) {
    process.stdout.write("No GitHub checks reported.\n");
    return;
  }
  for (const check of checks) {
    process.stdout.write(`${check.bucket.toUpperCase().padEnd(8)} ${check.name}: ${check.state}\n`);
  }
}

/**
 * Human gate before a repair commit is pushed. Interactive sessions review the
 * commit summary and confirm; non-interactive sessions must pass --yes.
 */
export async function confirmRepairPush(summary: RepairPushSummary, yes: boolean): Promise<boolean> {
  process.stdout.write(
    [
      "GitHub repair is ready to push:",
      `  remote: ${summary.remote}/${summary.branch}`,
      `  commit: ${summary.commitMessage}`,
      `  changes: ${summary.changedFiles.length} file(s), +${summary.additions} -${summary.deletions}`,
      ...summary.changedFiles.map((file) => `    ${file}`),
      "",
    ].join("\n"),
  );
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "Refusing to push without confirmation in a non-interactive session; re-run with --yes.\n",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Push this repair commit? [y/N] ");
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export function parseTail(value: string): number {
  const tail = Number(value);
  if (!Number.isInteger(tail) || tail < 0) {
    throw new Error(`Invalid --tail value '${value}'; expected a non-negative integer`);
  }
  return tail;
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port '${value}'`);
  }
  return port;
}

export function parseNonNegativeSafeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} value '${value}'; expected a non-negative safe integer`);
  }
  return parsed;
}

export function assertExclusiveConfigOptions(options: {
  config?: string;
  workspace?: string;
}): void {
  if (options.config && options.workspace) {
    throw new Error("Use either --config or --workspace, not both");
  }
}
