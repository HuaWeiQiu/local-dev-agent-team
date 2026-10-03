import { Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow } from "@xyflow/react";
import { memo, useMemo } from "react";
import { useFlowPalette } from "../flow-theme";
import { buildTaskGraph, TASK_NODE_GRID, TASK_NODE_GRID_COMPACT, type TaskNodeData } from "../graph";
import { completenessBarCopy, planCompletenessForRun, taskKind } from "../plan-completeness";
import { humanizeFailure, statusTone, strategyDisplayName, summarizeGoal } from "../presentation";
import type { StageId } from "../stages";
import type { RunEvent, RunState, TaskRunState } from "../types";
import { useMediaQuery } from "../useMediaQuery";
import { Badge } from "../ui/badge";
import { Callout } from "../ui/form";
import { ArchitectureDiagram } from "./architecture/ArchitectureDiagram";
import { ProcessDiagram } from "./architecture/ProcessDiagram";
import { PlanCompleteness } from "./run/PlanCompleteness";
import { TaskNode } from "./run/TaskNode";

const nodeTypes = { task: TaskNode };

interface DagCanvasProps {
  run: RunState | undefined;
  events?: RunEvent[];
  selectedTaskId: string | undefined;
  selectedStageId?: StageId;
  selectedModuleId?: string;
  onSelectTask(task: TaskRunState): void;
  onSelectStage?(id: StageId): void;
  onSelectModule?(id: string): void;
  onClearModule?(): void;
}

export const DagCanvas = memo(function DagCanvas({
  run,
  events = [],
  selectedTaskId,
  selectedStageId,
  selectedModuleId,
  onSelectTask,
  onSelectStage,
  onSelectModule,
  onClearModule,
}: DagCanvasProps) {
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
    <section aria-label="架构与任务图" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
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
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      {run && nodes.length > 0 && (
        <ArchitectureDiagram
          tasks={run.tasks}
          {...(run.plan?.design ? { design: run.plan.design } : {})}
          {...(run.repoTrace ? { repoTrace: run.repoTrace } : {})}
          {...(selectedModuleId ? { selectedModuleId } : {})}
          onSelectModule={onSelectModule ?? (() => undefined)}
          {...(onClearModule ? { onClearModule } : {})}
        />
      )}
      {nodes.length > 0 ? (
        <div className="relative h-[300px] shrink-0">
          <p className="pointer-events-none absolute left-3 top-2 z-10 m-0 text-2xs text-muted">任务 · 按依赖执行</p>
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
      ) : run ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
          <p className="m-0 mb-3 text-sm text-ink-2">
            架构还在拆任务。下面每一步都可以点开看正在发生什么，不用干等。
          </p>
          <ProcessDiagram
            run={run}
            events={events}
            {...(selectedStageId ? { selectedStageId } : {})}
            onSelectStage={onSelectStage ?? (() => undefined)}
          />
        </div>
      ) : null}
      </div>
    </section>
  );
});
