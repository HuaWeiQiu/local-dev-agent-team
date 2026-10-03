export const FLOW_TEMPLATE_NAMES = ["quick", "standard", "full"] as const;
export type FlowTemplateName = (typeof FLOW_TEMPLATE_NAMES)[number];

/** Stages of one run, in the order a template may arrange them. */
export const RUN_NODE_KINDS = [
  "intake",
  "explore",
  "plan",
  "approve-plan",
  "execute",
  "final-checks",
  "advise",
  "decide",
  "approve-final",
] as const;
export type RunNodeKind = (typeof RUN_NODE_KINDS)[number];

/** Steps every task goes through inside the `execute` stage. */
export const TASK_NODE_KINDS = ["work", "quality", "review", "test", "commit"] as const;
export type TaskNodeKind = (typeof TASK_NODE_KINDS)[number];

/**
 * Facts a condition can read. They are derived from the resolved strategy and
 * the goal by deterministic code only; no model output reaches a condition.
 */
export const FLOW_FACTS = [
  "needsArchitect",
  "exploreEnabled",
  "planGate",
  "advisorPreFinal",
  "evaluation",
] as const;
export type FlowFact = (typeof FLOW_FACTS)[number];
export type FlowFacts = Record<FlowFact, boolean>;

/** All listed facts must match (`expect` defaults to true). */
export interface FlowCondition {
  all: Array<{ fact: FlowFact; expect?: boolean }>;
}

export interface FlowNode<K extends string = string> {
  id: K;
  kind: K;
  /** Absent means the node always runs. */
  when?: FlowCondition;
  /** Template-specific switches that do not change the node's role. */
  params?: Record<string, string | number | boolean>;
}

export interface FlowEdge<K extends string = string> {
  from: K;
  to: K;
  /** Marks a bounded back edge (rework). Only task graphs may contain one. */
  loop?: boolean;
}

export interface FlowGraph<K extends string = string> {
  start: K;
  nodes: Array<FlowNode<K>>;
  edges: Array<FlowEdge<K>>;
}

export type RunGraph = FlowGraph<RunNodeKind>;
export type TaskGraph = FlowGraph<TaskNodeKind>;

export interface FlowTemplate {
  name: FlowTemplateName;
  summary: string;
  run: RunGraph;
  task: TaskGraph;
  /** How the template reshapes the strategy the run starts from. */
  strategy: {
    explore: "strategy" | "force";
    advisor: "strategy" | "force" | "off";
    planGate: "strategy" | "force" | "off";
  };
}

export type FlowSelectionSource = "router" | "user" | "config" | "evaluation";

/** Persisted on the run so resume rebuilds exactly the same graph. */
export interface FlowSelection {
  template: FlowTemplateName;
  source: FlowSelectionSource;
  reasons: string[];
  engine: "v2";
}
