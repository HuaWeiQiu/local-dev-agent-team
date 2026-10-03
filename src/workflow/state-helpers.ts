import { access } from "node:fs/promises";
import type { ExploreSummary } from "../domain/contracts.js";
import type {
  ApprovalRequest,
  RunCheckpoint,
  RunState,
  RunStatus,
  TaskRunState,
} from "../state/types.js";

export function latestCheckpoint(state: RunState): RunCheckpoint {
  const checkpoint = state.checkpoints?.at(-1);
  if (!checkpoint) {
    throw new Error(`Run '${state.id}' has no durable checkpoint`);
  }
  return checkpoint;
}

export function truncateExploreSummary(summary: ExploreSummary, maxChars: number): ExploreSummary {
  if (maxChars <= 0) {
    return {
      summary: summary.summary.slice(0, 200),
      modules: [],
      riskPaths: [],
      suggestedAcceptanceCommands: [],
      forbiddenPaths: [],
      notes: [],
    };
  }
  const clone: ExploreSummary = {
    summary: summary.summary,
    modules: [...summary.modules],
    riskPaths: [...summary.riskPaths],
    suggestedAcceptanceCommands: [...summary.suggestedAcceptanceCommands],
    forbiddenPaths: [...summary.forbiddenPaths],
    notes: [...summary.notes],
  };
  const encoded = () => JSON.stringify(clone);
  if (encoded().length <= maxChars) {
    return clone;
  }
  // Shrink arrays first, then summary text.
  while (encoded().length > maxChars) {
    if (clone.notes.length > 0) {
      clone.notes.pop();
      continue;
    }
    if (clone.suggestedAcceptanceCommands.length > 0) {
      clone.suggestedAcceptanceCommands.pop();
      continue;
    }
    if (clone.modules.length > 0) {
      clone.modules.pop();
      continue;
    }
    if (clone.riskPaths.length > 0) {
      clone.riskPaths.pop();
      continue;
    }
    if (clone.forbiddenPaths.length > 0) {
      clone.forbiddenPaths.pop();
      continue;
    }
    const budget = Math.max(80, maxChars - 40);
    clone.summary = `${clone.summary.slice(0, budget)}…`;
    break;
  }
  return clone;
}

export function latestApproval(
  state: RunState,
  gate: ApprovalRequest["gate"],
): ApprovalRequest | undefined {
  for (let index = (state.approvals?.length ?? 0) - 1; index >= 0; index -= 1) {
    const approval = state.approvals?.[index];
    if (approval?.gate === gate) return approval;
  }
  return undefined;
}

/**
 * A plan needs human approval only when the strategy gates "plan".
 * Project quality.commands remain the real gate; agent-authored
 * acceptanceCommands must not force an extra plan stop.
 */
export function requiresPlanApproval(state: RunState): boolean {
  return state.strategy.approvalGates.includes("plan");
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function resetIncompleteTask(task: TaskRunState): void {
  task.status = "pending";
  // attempts intentionally preserved: the rework limit must count across
  // resume segments, otherwise repeated pause/resume bypasses it.
  delete task.branch;
  delete task.worktree;
  delete task.commit;
  delete task.mergeCommit;
  delete task.merging;
  delete task.profile;
  delete task.quality;
  delete task.review;
  delete task.test;
  delete task.error;
}

export function isBudgetExceededError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "RUN_BUDGET_EXCEEDED";
}

export function recoveryArtifactKey(state: RunState, key: string): string {
  return state.resumeCount ? `recoveries/${state.resumeCount}/${key}` : key;
}

export function taskArtifactKey(
  state: RunState,
  taskId: string,
  attempt: number,
  artifact: string,
): string {
  return recoveryArtifactKey(state, `tasks/${taskId}/attempt-${attempt}/${artifact}`);
}

export function findTaskState(state: RunState, taskId: string): TaskRunState {
  const task = state.tasks.find((item) => item.task.id === taskId);
  if (!task) {
    throw new Error(`Missing state for task '${taskId}'`);
  }
  return task;
}

/**
 * Map workflow failure to a terminal status.
 * Explicit user cancel → cancelled; control-plane shutdown / other aborts → interrupted
 * so the UI can offer checkpoint resume instead of a full restart.
 */
export function terminalStatusAfterFailure(
  error: unknown,
  signal?: AbortSignal,
): Extract<RunStatus, "cancelled" | "interrupted" | "blocked"> {
  if (!signal?.aborted) return "blocked";
  const message = error instanceof Error ? error.message : String(error);
  // A user pause settles as interrupted: the run stays resumable from its
  // latest checkpoint instead of being discarded like a cancellation.
  if (/paused by user/i.test(message)) {
    return "interrupted";
  }
  if (/cancelled by user/i.test(message) || /^Run cancelled\b/i.test(message)) {
    return "cancelled";
  }
  return "interrupted";
}
