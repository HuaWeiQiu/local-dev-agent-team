import { activeRunStatuses, runStatusLabel } from "./presentation";
import type { RunStatus, RunSummary } from "./types";

export type BoardLane = "attention" | "active" | "done";

export const boardLaneLabels: Record<BoardLane, string> = {
  attention: "需要你",
  active: "执行中",
  done: "已结束",
};

export interface AttentionReason {
  label: string;
  /** Higher sorts first inside the lane. */
  priority: number;
  tone: "warning" | "danger" | "neutral";
}

const attentionReasons: Partial<Record<RunStatus, AttentionReason>> = {
  "awaiting-human": { label: "等你审批", priority: 5, tone: "warning" },
  "ready-to-merge": { label: "可以合并", priority: 4, tone: "warning" },
  "ci-failed": { label: "CI 失败", priority: 4, tone: "danger" },
  blocked: { label: "被阻塞", priority: 3, tone: "danger" },
  interrupted: { label: "已中断，可继续", priority: 2, tone: "neutral" },
};

const agentQuestionReason: AttentionReason = { label: "智能体在提问", priority: 6, tone: "warning" };

export function attentionReason(status: RunStatus): AttentionReason | undefined {
  return attentionReasons[status];
}

export function laneOf(status: RunStatus): BoardLane {
  if (attentionReasons[status]) return "attention";
  if (activeRunStatuses.has(status)) return "active";
  return "done";
}

export interface BoardCard {
  run: RunSummary;
  lane: BoardLane;
  reason?: AttentionReason;
  progress: { done: number; total: number };
  statusLabel: string;
}

export function taskProgress(counts: RunSummary["taskCounts"]): { done: number; total: number } {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { done: (counts.merged ?? 0) + (counts.passed ?? 0), total };
}

export function buildBoard(runs: RunSummary[]): Record<BoardLane, BoardCard[]> {
  const board: Record<BoardLane, BoardCard[]> = { attention: [], active: [], done: [] };
  for (const run of runs) {
    const asking = run.agentQuestions !== undefined && run.agentQuestions > 0 && activeRunStatuses.has(run.status);
    const lane = asking ? "attention" : laneOf(run.status);
    const reason = asking ? agentQuestionReason : attentionReason(run.status);
    board[lane].push({
      run,
      lane,
      ...(reason ? { reason } : {}),
      progress: taskProgress(run.taskCounts),
      statusLabel: runStatusLabel(run.status),
    });
  }
  const newestFirst = (left: BoardCard, right: BoardCard) =>
    right.run.updatedAt.localeCompare(left.run.updatedAt);
  board.attention.sort((left, right) =>
    (right.reason?.priority ?? 0) - (left.reason?.priority ?? 0) || newestFirst(left, right));
  board.active.sort(newestFirst);
  board.done.sort(newestFirst);
  return board;
}
