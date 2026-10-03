import { memo } from "react";
import type { StageBrief } from "../architecture";
import type { RunState, TaskDiff, TaskRunState } from "../types";
import { cn } from "../ui/cn";
import { ModuleDetail } from "./architecture/ModuleDetail";
import { StageDetail } from "./architecture/StageDetail";
import { RunDetail } from "./run/RunDetail";
import { TaskDetail } from "./run/TaskDetail";
import { RunStatusBadge, TaskStatusBadge } from "./StatusBadge";

interface TaskInspectorProps {
  run: RunState | undefined;
  task: TaskRunState | undefined;
  stage?: StageBrief;
  moduleId?: string;
  onSelectModule?(id: string): void;
  onClearModule?(): void;
  onSelectTask?(task: TaskRunState): void;
  onLoadDiff?(taskId: string): Promise<TaskDiff>;
  className?: string;
}

export const TaskInspector = memo(function TaskInspector({
  run,
  task,
  stage,
  moduleId,
  onSelectModule,
  onClearModule,
  onSelectTask,
  onLoadDiff,
  className,
}: TaskInspectorProps) {
  const title = task ? "任务详情" : moduleId ? "架构元素" : stage ? `${stage.stage.label}` : "运行详情";
  return (
    <aside aria-label={title} className={cn("flex h-full min-h-0 min-w-0 flex-col bg-surface", className)}>
      <header className="bd-b flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 py-3">
        <h2 className="m-0 text-sm font-semibold text-ink">{title}</h2>
        {task ? <TaskStatusBadge status={task.status} /> : run ? <RunStatusBadge status={run.status} /> : null}
      </header>
      {task || stage || run ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {task ? (
            <TaskDetail task={task} {...(run ? { run } : {})} {...(onLoadDiff ? { onLoadDiff } : {})} />
          ) : moduleId && run && onSelectTask && onSelectModule ? (
            <ModuleDetail
              tasks={run.tasks}
              moduleId={moduleId}
              {...(run.plan?.design ? { design: run.plan.design } : {})}
              {...(run.repoTrace ? { repoTrace: run.repoTrace } : {})}
              onSelectTask={onSelectTask}
              onSelectModule={onSelectModule}
              {...(onClearModule ? { onClearModule } : {})}
            />
          ) : stage && onSelectTask ? (
            <StageDetail brief={stage} onSelectTask={onSelectTask} />
          ) : run ? (
            <RunDetail run={run} />
          ) : null}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-xs text-muted">未选择运行</div>
      )}
    </aside>
  );
});
