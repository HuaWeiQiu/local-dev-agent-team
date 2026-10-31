import { Handle, type NodeProps } from "@xyflow/react";
import { Bot, GitPullRequest, ShieldCheck, Users } from "lucide-react";
import type { ReactNode } from "react";
import { agentRoleLabel } from "../../presentation";
import type { CompiledStrategyStage } from "../../types";
import { cn } from "../../ui/cn";
import { stageKindLabel, type StrategyNodeData } from "./draft";

const kindStyle: Record<CompiledStrategyStage["kind"], { icon: ReactNode; tile: string; bar: string }> = {
  agent: { icon: <Bot />, tile: "bg-info-soft text-info-ink", bar: "bg-info" },
  "worker-pool": { icon: <Users />, tile: "bg-violet/12 text-violet", bar: "bg-violet" },
  "quality-gate": { icon: <ShieldCheck />, tile: "bg-success-soft text-success-ink", bar: "bg-success" },
  "human-approval": { icon: <ShieldCheck />, tile: "bg-warning-soft text-warning-ink", bar: "bg-warning" },
  publication: { icon: <GitPullRequest />, tile: "bg-surface-3 text-ink-2", bar: "bg-muted" },
};

export function StrategyStageNode({ data, selected }: NodeProps) {
  const { stage, sourcePosition, targetPosition } = data as StrategyNodeData;
  const style = kindStyle[stage.kind];
  return (
    <div
      className={cn(
        "strategy-stage-node bd-strong relative flex min-h-[84px] w-[246px] items-center gap-3 overflow-hidden rounded-lg bg-surface px-3.5 py-3",
        selected && "outline-2 outline-offset-2 outline-accent",
      )}
    >
      <Handle type="target" position={targetPosition} />
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", style.bar)} />
      <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4", style.tile)}>
        {style.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <small className="text-2xs font-medium text-muted">{stageKindLabel(stage.kind)}</small>
        <strong className="truncate text-sm font-semibold text-ink">{stage.label}</strong>
        {stage.roles.length > 0 && (
          <span className="truncate font-mono text-2xs text-muted">{stage.roles.map(agentRoleLabel).join(" + ")}</span>
        )}
      </span>
      <Handle type="source" position={sourcePosition} />
    </div>
  );
}
