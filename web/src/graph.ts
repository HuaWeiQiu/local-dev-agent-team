import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import { flowPalette } from "./flow-theme";
import type { TaskRunState } from "./types";

/** 任务 DAG 节点网格：按 rank 横向分列，列内按序号纵向排列。 */
export const TASK_NODE_GRID = { columnWidth: 290, rowHeight: 138 } as const;
/** 窄屏紧凑网格：rank 改为纵向堆叠，列内序号横向展开（即标准网格的转置）。 */
export const TASK_NODE_GRID_COMPACT = { columnWidth: 280, rowHeight: 170 } as const;
/** 策略编排画布的阶段节点网格（蛇形布局）。 */
export const STRATEGY_STAGE_GRID = { columnWidth: 270, rowHeight: 160 } as const;

export interface TaskNodeData extends Record<string, unknown> {
  task: TaskRunState;
  compactLayout?: boolean;
}

export function buildTaskGraph(tasks: TaskRunState[]): {
  nodes: Array<Node<TaskNodeData>>;
  edges: Edge[];
} {
  const taskById = new Map(tasks.map((task) => [task.task.id, task]));
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();

  const rankOf = (id: string): number => {
    const cached = ranks.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    const task = taskById.get(id);
    const rank = task?.task.dependsOn.length
      ? Math.max(...task.task.dependsOn.map((dependency) => rankOf(dependency) + 1))
      : 0;
    visiting.delete(id);
    ranks.set(id, rank);
    return rank;
  };

  const columns = new Map<number, TaskRunState[]>();
  for (const task of tasks) {
    const rank = rankOf(task.task.id);
    columns.set(rank, [...(columns.get(rank) ?? []), task]);
  }

  const edgeColor = flowPalette().edge;
  const nodes: Array<Node<TaskNodeData>> = [];
  for (const [rank, column] of [...columns.entries()].sort(([left], [right]) => left - right)) {
    column.sort((left, right) => left.task.id.localeCompare(right.task.id));
    column.forEach((task, index) => {
      nodes.push({
        id: task.task.id,
        type: "task",
        position: { x: rank * TASK_NODE_GRID.columnWidth, y: index * TASK_NODE_GRID.rowHeight },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: { task },
      });
    });
  }

  const edges = tasks.flatMap((task) =>
    task.task.dependsOn.map((dependency) => ({
      id: `${dependency}-${task.task.id}`,
      source: dependency,
      target: task.task.id,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { stroke: edgeColor, strokeWidth: 1.5 },
    })),
  );
  return { nodes, edges };
}
