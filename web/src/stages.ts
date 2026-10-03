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
export function deriveStages(run: {
  status: RunStatus;
  history: ReadonlyArray<{ status: RunStatus }>;
}): StageView[] {
  const visited = new Set<number>();
  for (const entry of run.history) {
    const index = stageIndexOf(entry.status);
    if (index >= 0) visited.add(index);
  }
  let current = stageIndexOf(run.status);
  const stopped = terminalStopped.has(run.status);
  if (current < 0) {
    current = Math.max(-1, ...visited);
  }
  const completed = run.status === "completed";
  return stageDefinitions.map((stage, index): StageView => {
    const base = { id: stage.id, label: stage.label };
    if (completed) return { ...base, state: visited.has(index) ? "done" : "skipped" };
    if (index < current) return { ...base, state: visited.has(index) ? "done" : "skipped" };
    if (index === current) {
      return { ...base, state: stopped || run.status === "ci-failed" ? "failed" : "current" };
    }
    return { ...base, state: "pending" };
  });
}
