import { activeRunStatuses } from "../../presentation";
import type { RunState } from "../../types";

export function isActiveRun(run: RunState): boolean {
  return activeRunStatuses.has(run.status);
}

export function canResume(run: RunState): boolean {
  return run.status === "interrupted" && Boolean(run.checkpoints?.length);
}

/** Publish is offered once the integration branch is ready (or broke CI). */
export function canPublish(run: RunState): boolean {
  return run.status === "ready-to-merge" || run.status === "ci-failed";
}

const RETRYABLE = new Set<RunState["status"]>(["blocked", "cancelled", "interrupted"]);

export function canRetry(run: RunState): boolean {
  return RETRYABLE.has(run.status);
}

export function retryLabel(run: RunState): string {
  return run.status === "interrupted" ? "重新开始" : "重试为新运行";
}

export function retryHint(run: RunState): string {
  return run.status === "interrupted"
    ? "放弃检查点，用同一目标新开一条 run"
    : "以同一目标新开一条关联 run";
}

export function pruneLabel(run: RunState): string {
  return run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "PR";
}
