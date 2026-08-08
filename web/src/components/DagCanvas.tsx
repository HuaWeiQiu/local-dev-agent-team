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
import { useMemo } from "react";
import { buildTaskGraph, type TaskNodeData } from "../graph";
import { statusTone } from "../presentation";
import type { RunState, TaskRunState } from "../types";
import { TaskStatusBadge } from "./StatusBadge";

const nodeTypes = { task: TaskNode };

interface DagCanvasProps {
  run: RunState | undefined;
  selectedTaskId: string | undefined;
  onSelectTask(task: TaskRunState): void;
}

export function DagCanvas({ run, selectedTaskId, onSelectTask }: DagCanvasProps) {
  const graph = useMemo(() => buildTaskGraph(run?.tasks ?? []), [run?.tasks]);
  const nodes = graph.nodes.map((node) => ({ ...node, selected: node.id === selectedTaskId }));
  const completedTasks = run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;

  return (
    <main className="workspace-canvas" aria-label="任务依赖图">
      <div className="canvas-heading">
        <div>
          <span className="section-kicker">TASK GRAPH</span>
          <h2>{run?.plan?.summary ?? run?.goal ?? "任务编排"}</h2>
        </div>
        {run && (
          <div className="canvas-meta">
            <span>{completedTasks}/{run.tasks.length} 任务完成</span>
            <span className="strategy-chip">{run.strategy.name} · 并行 {run.strategy.maxParallel}</span>
          </div>
        )}
      </div>
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
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#d2d3cb" />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => toneColor(statusTone((node.data as TaskNodeData).task.status))}
              maskColor="rgba(244, 246, 245, 0.72)"
            />
          </ReactFlow>
        </div>
      ) : (
        <div className="canvas-empty">
          <Network size={30} />
          <strong>{run ? "等待任务规划" : "选择一个运行"}</strong>
          <span>{run ? "Architect 生成计划后会在此显示依赖图" : ""}</span>
        </div>
      )}
    </main>
  );
}

function TaskNode({ data, selected }: NodeProps) {
  const nodeData = data as TaskNodeData;
  const { task } = nodeData;
  return (
    <div className={`task-node tone-border-${statusTone(task.status)} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="task-node-topline">
        <code>{task.task.id}</code>
        <TaskStatusBadge status={task.status} />
      </div>
      <strong>{task.task.title}</strong>
      <div className="task-node-meta">
        <span>{task.profile ?? task.task.profile ?? "策略分配"}</span>
        <span>尝试 {task.attempts}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function toneColor(tone: string): string {
  return { success: "#26855f", danger: "#c24b4b", warning: "#c1812d", active: "#3574a6" }[tone] ?? "#78827e";
}
