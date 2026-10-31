import type { FlowCondition, FlowFacts, FlowNode, RunGraph, RunNodeKind } from "./types.js";

export type NodeOutcome = "done" | "park";

export type FlowNodeStatus = "started" | "completed" | "skipped" | "parked" | "failed";

export interface FlowNodeEvent {
  nodeId: RunNodeKind;
  status: FlowNodeStatus;
  reason?: string;
}

export interface FlowRuntime {
  facts: FlowFacts;
  handlers: Partial<Record<RunNodeKind, (node: FlowNode<RunNodeKind>) => Promise<NodeOutcome>>>;
  onNode?: (event: FlowNodeEvent) => void | Promise<void>;
}

export interface FlowRunResult {
  status: "completed" | "parked";
  /** Last node that ran or parked. */
  lastNode: RunNodeKind | undefined;
}

export function conditionHolds(condition: FlowCondition | undefined, facts: FlowFacts): boolean {
  if (!condition) return true;
  return condition.all.every((clause) => facts[clause.fact] === (clause.expect ?? true));
}

/** Nodes in execution order, ignoring conditions. */
export function orderedNodes(graph: RunGraph): Array<FlowNode<RunNodeKind>> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const next = new Map(graph.edges.filter((edge) => !edge.loop).map((edge) => [edge.from, edge.to]));
  const order: Array<FlowNode<RunNodeKind>> = [];
  let current: RunNodeKind | undefined = graph.start;
  while (current) {
    const node = byId.get(current);
    if (!node || order.includes(node)) break;
    order.push(node);
    current = next.get(current);
  }
  return order;
}

/**
 * Walks the run graph. A node whose condition is false is skipped; a handler
 * that returns "park" ends this segment (an approval is pending) and a later
 * resume re-enters the graph at the node that follows it.
 */
export async function runFlow(
  graph: RunGraph,
  runtime: FlowRuntime,
  options: { startAt?: RunNodeKind } = {},
): Promise<FlowRunResult> {
  const order = orderedNodes(graph);
  const startIndex = options.startAt ? order.findIndex((node) => node.id === options.startAt) : 0;
  if (startIndex < 0) throw new Error(`flow cannot start at unknown node '${options.startAt}'`);
  let lastNode: RunNodeKind | undefined;

  for (const node of order.slice(startIndex)) {
    if (!conditionHolds(node.when, runtime.facts)) {
      await runtime.onNode?.({ nodeId: node.id, status: "skipped", reason: "condition not met" });
      continue;
    }
    const handler = runtime.handlers[node.kind];
    if (!handler) throw new Error(`no handler registered for flow node '${node.kind}'`);
    lastNode = node.id;
    await runtime.onNode?.({ nodeId: node.id, status: "started" });
    let outcome: NodeOutcome;
    try {
      outcome = await handler(node);
    } catch (error) {
      await runtime.onNode?.({
        nodeId: node.id,
        status: "failed",
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
      throw error;
    }
    if (outcome === "park") {
      await runtime.onNode?.({ nodeId: node.id, status: "parked" });
      return { status: "parked", lastNode };
    }
    await runtime.onNode?.({ nodeId: node.id, status: "completed" });
  }
  return { status: "completed", lastNode };
}
