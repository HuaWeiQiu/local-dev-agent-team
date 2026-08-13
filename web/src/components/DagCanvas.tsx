import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { Network } from "lucide-react";
import { memo, useMemo } from "react";
import { useFlowPalette } from "../flow-theme";
import {
  buildTaskGraph,
  TASK_NODE_GRID,
  TASK_NODE_GRID_COMPACT,
  type TaskNodeData,
} from "../graph";
import {
  acceptanceSummary,
  completenessBarCopy,
  planCompletenessForRun,
  taskKind,
  taskKindLabel,
  taskPhaseLabel,
} from "../plan-completeness";
import { canvasEmptyCopy, humanizeFailure, statusTone, strategyDisplayName, summarizeGoal } from "../presentation";
import { useMediaQuery } from "../useMediaQuery";
import type { RunState, TaskRunState } from "../types";
import { TaskStatusBadge } from "./StatusBadge";

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

  return (
    <main className="workspace-canvas" aria-label="任务依赖图">
      <div className="canvas-heading">
        <div>
          <h2 title={run?.goal}>{run?.plan?.summary ?? (run ? summarizeGoal(run.goal, 64) : "任务编排")}</h2>
        </div>
        {run && (
          <div className="canvas-meta">
            <span>{completedTasks}/{run.tasks.length} 任务完成</span>
            <span className="strategy-chip" title={run.strategy.name}>
              {strategyDisplayName(run.strategy.name)}
              {" · "}并行 {run.strategy.maxParallel}
              {" · "}Swarm {run.strategy.swarmMaxConcurrency ?? run.strategy.maxParallel}
              {run.strategy.explore?.enabled ? " · 探索" : ""}
            </span>
          </div>
        )}
      </div>
      {completeness && completenessCopy ? (
        <details className={`canvas-completeness tone-${completenessCopy.tone}`} open={completeness.status !== "complete"}>
          <summary>
            <strong>{completenessCopy.title}</strong>
            <span>
              {completeness.namedDeliverables.length > 0
                ? `覆盖 ${completeness.coveredDeliverables.length}/${completeness.namedDeliverables.length}`
                : `${run?.tasks.length ?? 0} 条任务`}
            </span>
          </summary>
          {completeness.issues.length > 0 ? (
            <ul>
              {completeness.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          ) : (
            <p>目标编号已覆盖，无只读独苗。</p>
          )}
        </details>
      ) : null}
      {thinReconWarning && completeness?.status !== "rejected" ? (
        <div className="canvas-failure-banner tone-warning" role="status">
          <strong>计划可能不完整</strong>
          <span>目标含 {completeness?.namedDeliverables.join(" / ")}，图上只有一条只读侦察。</span>
        </div>
      ) : null}
      {run?.error ? (
        <div className="canvas-failure-banner" role="status">
          <strong>失败原因</strong>
          <span>{humanizeFailure(run.error)}</span>
        </div>
      ) : null}
      {nodes.length > 0 ? (
        <div className="flow-stage">
          <ReactFlow
            nodes={nodes}
            edges={graph.edges}
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
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => palette.tones[statusTone((node.data as TaskNodeData).task.status) as keyof typeof palette.tones] ?? palette.tones.neutral}
              maskColor={palette.minimapMask}
            />
          </ReactFlow>
        </div>
      ) : (
        <div className="canvas-empty">
          <Network size={30} />
          <strong>{emptyCopy.title}</strong>
          <span>{emptyCopy.detail}</span>
        </div>
      )}
    </main>
  );
});

function TaskNode({ data, selected }: NodeProps) {
  const nodeData = data as TaskNodeData;
  const { task } = nodeData;
  const kind = taskKind(task.task);
  const phase = taskPhaseLabel(task, nodeData.runStatus ?? "implementing");
  return (
    <div className={`task-node tone-border-${statusTone(task.status)} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={nodeData.compactLayout ? Position.Top : Position.Left} />
      <div className="task-node-topline">
        <code>{task.task.id}</code>
        <TaskStatusBadge status={task.status} />
      </div>
      <strong>{task.task.title}</strong>
      <div className="task-node-chips">
        <span>{taskKindLabel(kind)}</span>
        {phase ? <span>{phase}</span> : null}
      </div>
      <div className="task-node-meta">
        <span>{task.task.dependsOn.length > 0 ? `depends: ${task.task.dependsOn.join(", ")}` : "无依赖"}</span>
        <span>{acceptanceSummary(task.task)}</span>
      </div>
      <Handle type="source" position={nodeData.compactLayout ? Position.Bottom : Position.Right} />
    </div>
  );
}
