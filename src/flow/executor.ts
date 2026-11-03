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
  const startIndex = startIndexFor(order, options.startAt);
  let lastNode: RunNodeKind | undefined;

  for (const node of order.slice(startIndex)) {
    if (!conditionHolds(node.when, runtime.facts)) {
      await runtime.onNode?.({ nodeId: node.id, status: "skipped", reason: "condition not met" });
      continue;
    }
    lastNode = node.id;
    const outcome = await executeNode(node, runtime);
    if (outcome === "park") {
      await runtime.onNode?.({ nodeId: node.id, status: "parked" });
      return { status: "parked", lastNode };
    }
    await runtime.onNode?.({ nodeId: node.id, status: "completed" });
  }
  return { status: "completed", lastNode };
}

/** Where the walk starts: an explicit node, or the head of the graph. */
function startIndexFor(order: Array<FlowNode<RunNodeKind>>, startAt: RunNodeKind | undefined): number {
  if (!startAt) return 0;
  const index = order.findIndex((node) => node.id === startAt);
  if (index >= 0) return index;
  throw new Error(`flow cannot start at unknown node '${startAt}'`);
}

/** One node: announce it, run its handler, report a failure with the handler's message. */
async function executeNode(
  node: FlowNode<RunNodeKind>,
  runtime: FlowRuntime,
): Promise<NodeOutcome> {
  const handler = runtime.handlers[node.kind];
  if (!handler) throw new Error(`no handler registered for flow node '${node.kind}'`);
  await runtime.onNode?.({ nodeId: node.id, status: "started" });
  try {
    return await handler(node);
  } catch (error) {
    await runtime.onNode?.({ nodeId: node.id, status: "failed", reason: failureReason(error) });
    throw error;
  }
}

function failureReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
