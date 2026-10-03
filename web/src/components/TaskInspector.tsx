import { memo } from "react";
import type { RunState, TaskDiff, TaskRunState } from "../types";
import { cn } from "../ui/cn";
import { RunDetail } from "./run/RunDetail";
import { TaskDetail } from "./run/TaskDetail";
import { RunStatusBadge, TaskStatusBadge } from "./StatusBadge";

interface TaskInspectorProps {
  run: RunState | undefined;
  task: TaskRunState | undefined;
  onLoadDiff?(taskId: string): Promise<TaskDiff>;
  className?: string;
}

export const TaskInspector = memo(function TaskInspector({ run, task, onLoadDiff, className }: TaskInspectorProps) {
  return (
    <aside aria-label="任务详情" className={cn("flex h-full min-h-0 min-w-0 flex-col bg-surface", className)}>
      <header className="bd-b flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 py-3">
        <h2 className="m-0 text-sm font-semibold text-ink">{task ? "任务详情" : "运行详情"}</h2>
        {task ? <TaskStatusBadge status={task.status} /> : run ? <RunStatusBadge status={run.status} /> : null}
      </header>
      {task || run ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {task ? <TaskDetail task={task} {...(run ? { run } : {})} {...(onLoadDiff ? { onLoadDiff } : {})} /> : run ? <RunDetail run={run} /> : null}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-xs text-muted">未选择运行</div>
      )}
    </aside>
  );
});
