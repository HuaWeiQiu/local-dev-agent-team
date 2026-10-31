import type { Task, TaskRunState } from "../../../types";

/** The profile actually used: the run's recorded profile wins over the plan's. */
export function taskProfile(task: TaskRunState): string | undefined {
  return task.profile ?? task.task.profile ?? undefined;
}

export function dependsLabel(task: Task): string {
  return task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "无";
}

export function evidenceLabel(task: Task): string {
  return task.evidenceKind === "host-evidence" ? "实机证据" : "仓库命令 / 审查";
}

export function commandText(command: { spec: { command: string; args: string[] } }): string {
  return [command.spec.command, ...command.spec.args].join(" ");
}

export function findingLocation(finding: { path: string; line?: number | null }): string {
  return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

/** The run-level error is only worth repeating when it is a different failure. */
export function showRunError(taskError: string | undefined, runError: string | undefined): boolean {
  return Boolean(runError) && runError !== taskError;
}

export function hasReview(task: TaskRunState): boolean {
  return Boolean(task.review || task.test);
}
