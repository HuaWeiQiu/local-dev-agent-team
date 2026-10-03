import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { TaskNodeData } from "../../graph";
import { acceptanceSummary, taskKind, taskKindLabel, taskPhaseLabel } from "../../plan-completeness";
import { statusTone } from "../../presentation";
import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import { TaskStatusBadge } from "../StatusBadge";

const toneBar: Record<string, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  active: "bg-info",
  neutral: "bg-muted",
};

export function TaskNode({ data, selected }: NodeProps) {
  const nodeData = data as TaskNodeData;
  const { task } = nodeData;
  const phase = taskPhaseLabel(task, nodeData.runStatus ?? "implementing");
  const dependency = task.task.dependsOn.length > 0 ? `depends: ${task.task.dependsOn.join(", ")}` : "无依赖";
  const acceptance = acceptanceSummary(task.task);

  return (
    <div
      className={cn(
        "bd-strong relative w-[268px] cursor-pointer rounded-lg bg-surface px-3.5 pb-3 pt-3.5 shadow-card transition-shadow hover:shadow-pop",
        selected && "outline-2 outline-offset-2 outline-accent",
      )}
    >
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px] rounded-t-[7px]", toneBar[statusTone(task.status)] ?? toneBar.neutral)} />
      <Handle type="target" position={nodeData.compactLayout ? Position.Top : Position.Left} />
      <div className="flex items-center justify-between gap-2">
        <code className="min-w-0 truncate text-2xs text-muted">{task.task.id}</code>
        <TaskStatusBadge status={task.status} />
      </div>
      <strong className="mt-2 block truncate text-sm font-semibold text-ink" title={task.task.title}>{task.task.title}</strong>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge>{taskKindLabel(taskKind(task.task))}</Badge>
        {phase ? <Badge tone="active">{phase}</Badge> : null}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 text-2xs text-muted">
        <span className="min-w-0 max-w-[55%] truncate" title={dependency}>{dependency}</span>
        <span className="min-w-0 max-w-[45%] truncate" title={acceptance}>{acceptance}</span>
      </div>
      <Handle type="source" position={nodeData.compactLayout ? Position.Bottom : Position.Right} />
    </div>
  );
}
