import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { TaskNodeData } from "../../graph";
import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import { TaskStatusBadge } from "../StatusBadge";
import { taskNodeView } from "./task-node/model";

export function TaskNode({ data, selected }: NodeProps) {
  const nodeData = data as TaskNodeData;
  const view = taskNodeView(nodeData);
  const { task } = nodeData;

  return (
    <div
      className={cn(
        "bd-strong relative w-[268px] cursor-pointer rounded-lg bg-surface px-3.5 pb-3 pt-3.5",
        selected && "outline-2 outline-offset-2 outline-accent",
      )}
    >
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px] rounded-t-[7px]", view.toneBar)} />
      <Handle type="target" position={view.compact ? Position.Top : Position.Left} />
      <div className="flex items-center justify-between gap-2">
        <code className="min-w-0 truncate text-2xs text-muted">{view.id}</code>
        <TaskStatusBadge status={task.status} />
      </div>
      <strong className="mt-2 block truncate text-sm font-semibold text-ink" title={view.title}>{view.title}</strong>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge>{view.kind}</Badge>
        {view.phase ? <Badge tone="active">{view.phase}</Badge> : null}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2 text-2xs text-muted">
        <span className="min-w-0 max-w-[55%] truncate" title={view.dependency}>{view.dependency}</span>
        <span className="min-w-0 max-w-[45%] truncate" title={view.acceptance}>{view.acceptance}</span>
      </div>
      <Handle type="source" position={view.compact ? Position.Bottom : Position.Right} />
    </div>
  );
}
