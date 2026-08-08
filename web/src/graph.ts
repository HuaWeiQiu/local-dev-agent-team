import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import type { TaskRunState } from "./types";

export interface TaskNodeData extends Record<string, unknown> {
  task: TaskRunState;
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

  const nodes: Array<Node<TaskNodeData>> = [];
  for (const [rank, column] of [...columns.entries()].sort(([left], [right]) => left - right)) {
    column.sort((left, right) => left.task.id.localeCompare(right.task.id));
    column.forEach((task, index) => {
      nodes.push({
        id: task.task.id,
        type: "task",
        position: { x: rank * 290, y: index * 138 },
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
      style: { stroke: "#8a9691", strokeWidth: 1.5 },
    })),
  );
  return { nodes, edges };
}
