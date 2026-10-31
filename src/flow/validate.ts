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
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push(`${label}: duplicate node '${node.id}'`);
    ids.add(node.id);
    if (!kinds.includes(node.kind)) issues.push(`${label}: unknown node kind '${node.kind}'`);
    if (node.id !== node.kind) issues.push(`${label}: node id '${node.id}' must equal its kind`);
    for (const clause of node.when?.all ?? []) {
      if (!(FLOW_FACTS as readonly string[]).includes(clause.fact)) {
        issues.push(`${label}: node '${node.id}' reads unknown fact '${clause.fact}'`);
      }
    }
  }
  if (!ids.has(graph.start)) issues.push(`${label}: start '${graph.start}' is not a node`);

  const forward = new Map<string, string[]>();
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

function runInvariantIssues(template: FlowTemplate): string[] {
  const order = orderOf(template.run);
  const issues: string[] = [];
  for (const required of ["plan", "execute", "final-checks", "decide", "approve-final"]) {
    if (!order.includes(required)) issues.push(`run: required node '${required}' is missing`);
  }
  const before = (a: string, b: string): boolean =>
    order.includes(a) && order.includes(b) && order.indexOf(a) < order.indexOf(b);
  if (!before("plan", "execute")) issues.push("run: plan must precede execute");
  if (!before("execute", "final-checks")) issues.push("run: execute must precede final-checks");
  if (!before("final-checks", "decide")) issues.push("run: final-checks must precede decide");
  if (!before("decide", "approve-final")) issues.push("run: decide must precede approve-final");
  if (order.at(-1) !== "approve-final") issues.push("run: approve-final must be the last node");
  if (before("approve-plan", "plan")) issues.push("run: approve-plan cannot precede plan");
  for (const mandatory of ["plan", "execute", "final-checks", "decide", "approve-final"]) {
    if (template.run.nodes.find((node) => node.id === mandatory)?.when) {
      issues.push(`run: '${mandatory}' cannot be conditional`);
    }
  }
  return issues;
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
