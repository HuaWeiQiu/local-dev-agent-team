import { Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow } from "@xyflow/react";
import { Network } from "lucide-react";
import { memo, useMemo } from "react";
import { useFlowPalette } from "../flow-theme";
import { buildTaskGraph, TASK_NODE_GRID, TASK_NODE_GRID_COMPACT, type TaskNodeData } from "../graph";
import { completenessBarCopy, planCompletenessForRun, taskKind } from "../plan-completeness";
import { canvasEmptyCopy, humanizeFailure, statusTone, strategyDisplayName, summarizeGoal } from "../presentation";
import type { RunState, TaskRunState } from "../types";
import { useMediaQuery } from "../useMediaQuery";
import { Badge } from "../ui/badge";
import { Callout } from "../ui/form";
import { EmptyState } from "./EmptyState";
import { PlanCompleteness } from "./run/PlanCompleteness";
import { TaskNode } from "./run/TaskNode";

const nodeTypes = { task: TaskNode };

interface DagCanvasProps {
  run: RunState | undefined;
  selectedTaskId: string | undefined;
  onSelectTask(task: TaskRunState): void;
}

export const DagCanvas = memo(function DagCanvas({ run, selectedTaskId, onSelectTask }: DagCanvasProps) {
  const compactLayout = useMediaQuery("(max-width: 800px)");
  const palette = useFlowPalette();
  const graph = useMemo(
    () => buildTaskGraph(run?.tasks ?? []),
    // palette.edge forces a rebuild of edge styling when the theme changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palette.edge, run?.tasks],
  );
  const nodes = useMemo(
    () =>
      graph.nodes.map((node) => ({
        ...node,
        position: compactLayout
          ? {
              x: (node.position.y / TASK_NODE_GRID.rowHeight) * TASK_NODE_GRID_COMPACT.columnWidth,
              y: (node.position.x / TASK_NODE_GRID.columnWidth) * TASK_NODE_GRID_COMPACT.rowHeight,
            }
          : node.position,
        data: { ...node.data, compactLayout, runStatus: run?.status },
        selected: node.id === selectedTaskId,
      })),
    [compactLayout, graph, run?.status, selectedTaskId],
  );
  const edges = useMemo(
    () =>
      selectedTaskId === undefined
        ? graph.edges
        : graph.edges.map((edge) =>
            edge.source === selectedTaskId || edge.target === selectedTaskId
              ? {
                  ...edge,
                  zIndex: 1,
                  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: palette.edgeActive },
                  style: { stroke: palette.edgeActive, strokeWidth: 2 },
                }
              : edge,
          ),
    [graph.edges, palette.edgeActive, selectedTaskId],
  );
  const completedTasks = run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;
  const emptyCopy = canvasEmptyCopy(run);
  const completeness = run ? planCompletenessForRun(run) : undefined;
  const completenessCopy = completeness ? completenessBarCopy(completeness) : undefined;
  const thinReconWarning = Boolean(
    completeness
    && completeness.namedDeliverables.length > 0
    && run
    && run.tasks.length === 1
    && taskKind(run.tasks[0]!.task) === "recon",
  );
  const failure = run?.error ? humanizeFailure(run.error) : undefined;
  const hasBanners = Boolean(completeness && completenessCopy) || thinReconWarning || Boolean(run?.error);

  return (
    <section aria-label="任务依赖图" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="canvas-heading contents">
        <header className="bd-b flex flex-wrap items-center gap-x-4 gap-y-1.5 bg-surface px-4 py-2.5 md:px-6">
          <h2 className="m-0 min-w-0 flex-1 basis-56 truncate text-sm font-semibold leading-snug text-ink" title={run?.goal}>
            {run?.plan?.summary ?? (run ? summarizeGoal(run.goal, 64) : "任务编排")}
          </h2>
          {run && (
            <div className="flex min-w-0 max-w-full items-center gap-2.5 text-xs text-muted">
              <span className="shrink-0 tabular-nums">{completedTasks}/{run.tasks.length} 任务完成</span>
              <Badge tone="active" className="min-w-0 max-w-full" title={run.strategy.name}>
                <span className="truncate">
                  {strategyDisplayName(run.strategy.name)}
                  {" · "}并行 {run.strategy.maxParallel}
                  {" · "}Swarm {run.strategy.swarmMaxConcurrency ?? run.strategy.maxParallel}
                  {run.strategy.explore?.enabled ? " · 探索" : ""}
                  {run.strategy.advisor?.enabled
                    ? ` · 顾问 ${run.advisorConsultations ?? 0}/${run.strategy.advisor.maxConsultationsPerRun}`
                    : ""}
                </span>
              </Badge>
            </div>
          )}
        </header>
      </div>
      {hasBanners && (
        <div className="flex flex-col gap-2 px-4 pt-3 md:px-6">
          {completeness && completenessCopy && (
            <PlanCompleteness report={completeness} tone={completenessCopy.tone} title={completenessCopy.title} taskCount={run?.tasks.length ?? 0} />
          )}
          {thinReconWarning && completeness?.status !== "rejected" && (
            <Callout tone="warning" role="status">
              <strong className="font-semibold">计划可能不完整</strong>
              <span className="ml-2">目标含 {completeness?.namedDeliverables.join(" / ")}，图上只有一条只读侦察。</span>
            </Callout>
          )}
          {run?.error && (
            <Callout tone="danger" role="status">
              <strong className="font-semibold">失败原因</strong>
              <span className="ml-2 break-words">{failure}</span>
            </Callout>
          )}
        </div>
      )}
      {nodes.length > 0 ? (
        <div className="relative min-h-72 flex-1">
          <div className="absolute inset-0">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_event, node) => onSelectTask(node.data.task)}
              fitView
              fitViewOptions={{ padding: 0.24 }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              minZoom={0.35}
              maxZoom={1.5}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={palette.dot} />
              <Controls showInteractive={false} />
              {!compactLayout && (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => palette.tones[statusTone((node.data as TaskNodeData).task.status) as keyof typeof palette.tones] ?? palette.tones.neutral}
                  maskColor={palette.minimapMask}
                />
              )}
            </ReactFlow>
          </div>
        </div>
      ) : (
        <EmptyState icon={<Network />} title={emptyCopy.title} hint={emptyCopy.detail} />
      )}
    </section>
  );
});
