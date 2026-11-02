import type { RunStatus } from "./types";

export type StageId =
  | "intake"
  | "explore"
  | "plan"
  | "build"
  | "review"
  | "integrate"
  | "gates"
  | "approval"
  | "ship";

export interface StageDefinition {
  id: StageId;
  label: string;
  statuses: RunStatus[];
}

export const stageDefinitions: StageDefinition[] = [
  { id: "intake", label: "理解目标", statuses: ["created", "orchestrating"] },
  { id: "explore", label: "探索", statuses: ["exploring"] },
  { id: "plan", label: "规划", statuses: ["architecting", "planned"] },
  { id: "build", label: "实现", statuses: ["implementing", "reworking"] },
  { id: "review", label: "评审测试", statuses: ["reviewing-testing"] },
  { id: "integrate", label: "集成", statuses: ["integrating"] },
  { id: "gates", label: "质量门", statuses: ["final-checks"] },
  { id: "approval", label: "审批", statuses: ["awaiting-human"] },
  { id: "ship", label: "合并", statuses: ["publishing", "waiting-ci", "repairing", "ready-to-merge", "ci-failed"] },
];

export type StageState = "done" | "current" | "failed" | "pending" | "skipped";

export interface StageView {
  id: StageId;
  label: string;
  state: StageState;
}

const terminalStopped = new Set<RunStatus>(["blocked", "cancelled", "interrupted"]);

function stageIndexOf(status: RunStatus): number {
  return stageDefinitions.findIndex((stage) => stage.statuses.includes(status));
}

/**
 * Progress through the delivery pipeline derived from run status and history.
 * Stopped runs are placed at the last pipeline status they reached; stages that
 * the run never entered but later stages passed are shown as skipped (for
 * example explore, or approval when no gate was configured).
 */
interface StageProgress {
  current: number;
  failed: boolean;
  completed: boolean;
  visited: ReadonlySet<number>;
}

function visitedStages(history: ReadonlyArray<{ status: RunStatus }>): Set<number> {
  const visited = new Set<number>();
  for (const entry of history) {
    const index = stageIndexOf(entry.status);
    if (index >= 0) visited.add(index);
  }
  return visited;
}

/** The stage a run is parked at: its own status, or the last one it reached. */
function currentStageIndex(status: RunStatus, visited: ReadonlySet<number>): number {
  const index = stageIndexOf(status);
  return index < 0 ? Math.max(-1, ...visited) : index;
}

function stageState(index: number, progress: StageProgress): StageState {
  if (progress.completed) return progress.visited.has(index) ? "done" : "skipped";
  if (index < progress.current) return progress.visited.has(index) ? "done" : "skipped";
  if (index > progress.current) return "pending";
  return progress.failed ? "failed" : "current";
}

export function deriveStages(run: {
  status: RunStatus;
  history: ReadonlyArray<{ status: RunStatus }>;
}): StageView[] {
  const visited = visitedStages(run.history);
  const progress: StageProgress = {
    visited,
    current: currentStageIndex(run.status, visited),
    completed: run.status === "completed",
    failed: terminalStopped.has(run.status) || run.status === "ci-failed",
  };
  return stageDefinitions.map((stage, index): StageView => ({
    id: stage.id,
    label: stage.label,
    state: stageState(index, progress),
  }));
}
