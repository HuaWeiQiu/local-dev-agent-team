import type { RunStatus, TaskStatus } from "../types";
import { RunStatusPill, TaskStatusPill } from "../ui/status";

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <RunStatusPill status={status} />;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <TaskStatusPill status={status} />;
}
