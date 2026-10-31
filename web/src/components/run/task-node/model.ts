import type { TaskNodeData } from "../../../graph";
import { acceptanceSummary, taskKind, taskKindLabel, taskPhaseLabel } from "../../../plan-completeness";
import { statusTone } from "../../../presentation";

/** The tone bar colour for each status tone. */
const TONE_BAR: Record<string, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  active: "bg-info",
  neutral: "bg-muted",
};

export interface TaskNodeView {
  id: string;
  title: string;
  status: TaskNodeData["task"]["status"];
  kind: string;
  phase: string | undefined;
  dependency: string;
  acceptance: string;
  toneBar: string;
  compact: boolean;
}

/**
 * Everything a task node shows, derived from its data. Kept out of the component
 * so the wording can be tested without a React Flow canvas.
 */
export function taskNodeView(data: TaskNodeData): TaskNodeView {
  const { task } = data;
  const runStatus = data.runStatus ?? "implementing";
  return {
    id: task.task.id,
    title: task.task.title,
    status: task.status,
    kind: taskKindLabel(taskKind(task.task)),
    phase: taskPhaseLabel(task, runStatus),
    dependency: dependencyLabel(task.task.dependsOn),
    acceptance: acceptanceSummary(task.task),
    toneBar: TONE_BAR[statusTone(task.status)] ?? TONE_BAR.neutral!,
    compact: data.compactLayout === true,
  };
}

/** A node with no dependencies says so rather than showing an empty line. */
export function dependencyLabel(dependsOn: readonly string[]): string {
  return dependsOn.length > 0 ? `depends: ${dependsOn.join(", ")}` : "无依赖";
}
