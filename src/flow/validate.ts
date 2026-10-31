import {
  FLOW_FACTS,
  RUN_NODE_KINDS,
  TASK_NODE_KINDS,
  type FlowGraph,
  type FlowTemplate,
} from "./types.js";

export class FlowValidationError extends Error {
  override readonly name = "FlowValidationError";
  constructor(readonly issues: string[]) {
    super(`invalid flow: ${issues.join("; ")}`);
  }
}

/**
 * Structural checks plus the safety invariants no template may remove:
 * deterministic quality gates run before anything is committed, and final
 * checks and the final human approval are on every path to the end.
 */
export function validateTemplate(template: FlowTemplate): void {
  const issues: string[] = [];
  issues.push(...structuralIssues("run", template.run, RUN_NODE_KINDS, false));
  issues.push(...structuralIssues("task", template.task, TASK_NODE_KINDS, true));
  issues.push(...runInvariantIssues(template));
  issues.push(...taskInvariantIssues(template));
  if (issues.length > 0) throw new FlowValidationError(issues);
}

function structuralIssues(
  label: string,
  graph: FlowGraph,
  kinds: readonly string[],
  allowLoops: boolean,
): string[] {
  const issues: string[] = [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  issues.push(...nodeIssues(label, graph, kinds, ids));
  if (!ids.has(graph.start)) issues.push(`${label}: start '${graph.start}' is not a node`);
  const forward = new Map<string, string[]>();
  issues.push(...edgeIssues(label, graph, ids, allowLoops, forward));
  issues.push(...reachabilityIssues(label, graph, ids, forward));
  return issues;
}

/** Node identity, kind and the facts a condition may read. */
function nodeIssues(
  label: string,
  graph: FlowGraph,
  kinds: readonly string[],
  ids: Set<string>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    issues.push(...singleNodeIssues(label, node, seen, kinds));
    ids.add(node.id);
  }
  return issues;
}

/** One node's own problems: identity, kind, and the facts its condition reads. */
function singleNodeIssues(
  label: string,
  node: FlowGraph["nodes"][number],
  seen: Set<string>,
  kinds: readonly string[],
): string[] {
  const issues: string[] = [];
  if (seen.has(node.id)) issues.push(`${label}: duplicate node '${node.id}'`);
  seen.add(node.id);
  if (!kinds.includes(node.kind)) issues.push(`${label}: unknown node kind '${node.kind}'`);
  if (node.id !== node.kind) issues.push(`${label}: node id '${node.id}' must equal its kind`);
  issues.push(...unknownFactIssues(label, node.id, node.when?.all ?? []));
  return issues;
}

function unknownFactIssues(
  label: string,
  nodeId: string,
  clauses: ReadonlyArray<{ fact: string }>,
): string[] {
  return clauses
    .filter((clause) => !(FLOW_FACTS as readonly string[]).includes(clause.fact))
    .map((clause) => `${label}: node '${nodeId}' reads unknown fact '${clause.fact}'`);
}

/** Edges must join known nodes, and only task graphs may loop. */
function edgeIssues(
  label: string,
  graph: FlowGraph,
  ids: Set<string>,
  allowLoops: boolean,
  forward: Map<string, string[]>,
): string[] {
  const issues: string[] = [];
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      issues.push(`${label}: edge ${edge.from} -> ${edge.to} references a missing node`);
      continue;
    }
    if (edge.loop) {
      if (!allowLoops) issues.push(`${label}: loop edge ${edge.from} -> ${edge.to} is not allowed`);
      continue;
    }
    forward.set(edge.from, [...(forward.get(edge.from) ?? []), edge.to]);
  }
  for (const [from, targets] of forward) {
    if (targets.length > 1) issues.push(`${label}: node '${from}' branches; templates are linear`);
  }

  return issues;
}

/** Every node is reachable from the start, and no forward edge closes a cycle. */
function reachabilityIssues(
  label: string,
  graph: FlowGraph,
  ids: Set<string>,
  forward: Map<string, string[]>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const walk = (id: string): void => {
    if (visiting.has(id)) {
      issues.push(`${label}: cycle through '${id}'`);
      return;
    }
    if (seen.has(id)) return;
    visiting.add(id);
    seen.add(id);
    for (const next of forward.get(id) ?? []) walk(next);
    visiting.delete(id);
  };
  if (ids.has(graph.start)) walk(graph.start);
  for (const id of ids) {
    if (!seen.has(id)) issues.push(`${label}: node '${id}' is unreachable from '${graph.start}'`);
  }
  return issues;
}

function orderOf(graph: FlowGraph): string[] {
  const next = new Map(graph.edges.filter((edge) => !edge.loop).map((edge) => [edge.from, edge.to]));
  const order: string[] = [];
  let current: string | undefined = graph.start;
  while (current && !order.includes(current)) {
    order.push(current);
    current = next.get(current);
  }
  return order;
}

/** The run must plan, execute, check, decide and get a final approval, in that order. */
const RUN_CHAIN = ["plan", "execute", "final-checks", "decide", "approve-final"] as const;

function runInvariantIssues(template: FlowTemplate): string[] {
  const order = orderOf(template.run);
  return [
    ...missingNodes("run", order, RUN_CHAIN),
    ...chainIssues(order, RUN_CHAIN, "run"),
    ...unconditionalIssues("run", template.run, RUN_CHAIN),
  ];
}

function missingNodes(label: string, order: readonly string[], required: readonly string[]): string[] {
  return required
    .filter((node) => !order.includes(node))
    .map((node) => `${label}: required node '${node}' is missing`);
}

/** Each step must come after the one before it, and the last one must be last. */
function chainIssues(order: readonly string[], chain: readonly string[], label: string): string[] {
  const issues: string[] = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    const before = chain[index]!;
    const after = chain[index + 1]!;
    if (!precedes(order, before, after)) {
      issues.push(`${label}: ${before} must precede ${after}`);
    }
  }
  if (order.at(-1) !== chain.at(-1)) {
    issues.push(`${label}: ${chain.at(-1)} must be the last node`);
  }
  return issues;
}

function precedes(order: readonly string[], before: string, after: string): boolean {
  return order.includes(before) && order.includes(after) && order.indexOf(before) < order.indexOf(after);
}

/** A step the run cannot skip may not be conditional either. */
function unconditionalIssues(label: string, graph: FlowGraph, ids: readonly string[]): string[] {
  return graph.nodes
    .filter((node) => ids.includes(node.id) && node.when)
    .map((node) => `${label}: '${node.id}' cannot be conditional`);
}

function taskInvariantIssues(template: FlowTemplate): string[] {
  const order = orderOf(template.task);
  const issues: string[] = [];
  for (const required of ["work", "quality", "commit"]) {
    if (!order.includes(required)) issues.push(`task: required node '${required}' is missing`);
  }
  if (order.indexOf("work") !== 0) issues.push("task: work must come first");
  if (order.indexOf("quality") !== order.indexOf("work") + 1) {
    issues.push("task: quality must directly follow work");
  }
  if (order.at(-1) !== "commit") issues.push("task: commit must be the last node");
  if (order.includes("review") !== order.includes("test")) {
    issues.push("task: review and test run together; include both or neither");
  }
  for (const node of template.task.nodes) {
    if (node.when) issues.push(`task: '${node.id}' cannot be conditional`);
  }
  return issues;
}
