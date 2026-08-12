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
import { canvasEmptyCopy, humanizeFailure, statusTone, summarizeGoal } from "../presentation";
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
        data: { ...node.data, compactLayout },
        selected: node.id === selectedTaskId,
      })),
    [compactLayout, graph, selectedTaskId],
  );
  const completedTasks = run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;
  const emptyCopy = canvasEmptyCopy(run);

  return (
    <main className="workspace-canvas" aria-label="任务依赖图">
      <div className="canvas-heading">
        <div>
          <h2 title={run?.goal}>{run?.plan?.summary ?? (run ? summarizeGoal(run.goal, 64) : "任务编排")}</h2>
        </div>
        {run && (
          <div className="canvas-meta">
            <span>{completedTasks}/{run.tasks.length} 任务完成</span>
            <span className="strategy-chip">{run.strategy.name} · 并行 {run.strategy.maxParallel}</span>
          </div>
        )}
      </div>
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
  return (
    <div className={`task-node tone-border-${statusTone(task.status)} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={nodeData.compactLayout ? Position.Top : Position.Left} />
      <div className="task-node-topline">
        <code>{task.task.id}</code>
        <TaskStatusBadge status={task.status} />
      </div>
      <strong>{task.task.title}</strong>
      <div className="task-node-meta">
        <span>{task.profile ?? task.task.profile ?? "策略分配"}</span>
        <span>尝试 {task.attempts}</span>
      </div>
      <Handle type="source" position={nodeData.compactLayout ? Position.Bottom : Position.Right} />
    </div>
  );
}
