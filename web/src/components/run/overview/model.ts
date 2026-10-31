import { formatElapsed } from "../../../live-status";
import type { RunState } from "../../../types";

const TERMINAL_STATUSES = new Set<RunState["status"]>([
  "completed",
  "cancelled",
  "blocked",
  "interrupted",
  "ci-failed",
  "ready-to-merge",
]);

export function isTerminal(status: RunState["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Elapsed time freezes at the last update once the run is over. */
export function elapsedLabel(run: RunState, now = Date.now()): string {
  return formatElapsed(run.createdAt, isTerminal(run.status) ? Date.parse(run.updatedAt) : now);
}

export function completedTasks(run: RunState): number {
  return run.tasks.filter((task) => task.status === "passed" || task.status === "merged").length;
}

export function reworkCount(run: RunState): number {
  return run.tasks.reduce((sum, task) => sum + Math.max(0, task.attempts - 1), 0);
}

export interface SummaryStat {
  label: string;
  value: string;
  icon: "clock" | "cpu" | "coins" | "list";
}

export function summaryStats(run: RunState, now = Date.now()): SummaryStat[] {
  const usage = run.usage;
  return [
    { icon: "clock", label: "耗时", value: elapsedLabel(run, now) },
    {
      icon: "cpu",
      label: "调用",
      value: `${usage?.agentInvocations ?? 0}/${run.strategy.maxAgentInvocations}`,
    },
    {
      icon: "coins",
      label: "成本",
      value: usage?.reportedCostUsd != null ? `$${usage.reportedCostUsd.toFixed(2)}` : "—",
    },
    { icon: "list", label: "返工", value: String(reworkCount(run)) },
  ];
}

export function headlineToneClass(tone: string | undefined): string {
  if (tone === "good") return "text-success-ink";
  if (tone === "bad") return "text-danger-ink";
  if (tone === "warn") return "text-warning-ink";
  return "text-ink-2";
}

export function decisionLabel(decision: "ready" | "escalate"): string {
  return decision === "ready" ? "总控：可交付" : "总控：需升级";
}
