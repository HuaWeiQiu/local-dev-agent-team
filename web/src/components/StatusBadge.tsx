import { runStatusLabel, statusTone, taskStatusLabel } from "../presentation";
import type { RunStatus, TaskStatus } from "../types";

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <span className={`status-badge tone-${statusTone(status)}`}>{runStatusLabel(status)}</span>;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-badge tone-${statusTone(status)}`}>{taskStatusLabel(status)}</span>;
}
