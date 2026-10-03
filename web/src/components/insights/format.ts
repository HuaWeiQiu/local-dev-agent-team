import type { ExplainTone } from "../../types";

export const toneText: Record<ExplainTone, string> = {
  good: "text-success-ink",
  warn: "text-warning-ink",
  bad: "text-danger-ink",
  neutral: "text-ink-2",
};

export const toneDot: Record<ExplainTone, string> = {
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-danger",
  neutral: "bg-muted/60",
};

export function formatCost(costUsd: number, reported: boolean): string {
  if (!reported) return "未上报";
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}
