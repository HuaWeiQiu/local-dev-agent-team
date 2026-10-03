import type {
  FlowCondition,
  FlowEdge,
  FlowTemplate,
  FlowTemplateName,
  RunGraph,
  RunNodeKind,
  TaskGraph,
  TaskNodeKind,
} from "./types.js";

function chain<K extends string>(kinds: readonly K[]): Array<FlowEdge<K>> {
  return kinds.slice(1).map((to, index) => ({ from: kinds[index]!, to }));
}

const needsArchitect: FlowCondition = { all: [{ fact: "needsArchitect" }] };
const exploring: FlowCondition = {
  all: [{ fact: "needsArchitect" }, { fact: "exploreEnabled" }],
};
const planApproval: FlowCondition = {
  all: [{ fact: "planGate" }, { fact: "evaluation", expect: false }],
};
const preFinalAdvice: FlowCondition = { all: [{ fact: "advisorPreFinal" }] };

const standardRunOrder: RunNodeKind[] = [
  "intake",
  "explore",
  "plan",
  "approve-plan",
  "execute",
  "final-checks",
  "advise",
  "decide",
  "approve-final",
];

const standardRun: RunGraph = {
  start: "intake",
  nodes: [
    { id: "intake", kind: "intake", when: needsArchitect },
    { id: "explore", kind: "explore", when: exploring },
    { id: "plan", kind: "plan", params: { planner: "architect" } },
    { id: "approve-plan", kind: "approve-plan", when: planApproval },
    { id: "execute", kind: "execute" },
    { id: "final-checks", kind: "final-checks" },
    { id: "advise", kind: "advise", when: preFinalAdvice },
    { id: "decide", kind: "decide", params: { mode: "llm" } },
    { id: "approve-final", kind: "approve-final" },
  ],
  edges: chain(standardRunOrder),
};

const quickRunOrder: RunNodeKind[] = ["plan", "execute", "final-checks", "decide", "approve-final"];

const quickRun: RunGraph = {
  start: "plan",
  nodes: [
    { id: "plan", kind: "plan", params: { planner: "single-task" } },
    { id: "execute", kind: "execute" },
    { id: "final-checks", kind: "final-checks" },
    { id: "decide", kind: "decide", params: { mode: "deterministic" } },
    { id: "approve-final", kind: "approve-final" },
  ],
  edges: chain(quickRunOrder),
};

const standardTaskOrder: TaskNodeKind[] = ["work", "quality", "review", "test", "commit"];

const standardTask: TaskGraph = {
  start: "work",
  nodes: standardTaskOrder.map((kind) => ({ id: kind, kind })),
  edges: [...chain(standardTaskOrder), { from: "test", to: "work", loop: true }],
};

const quickTaskOrder: TaskNodeKind[] = ["work", "quality", "commit"];

const quickTask: TaskGraph = {
  start: "work",
  nodes: quickTaskOrder.map((kind) => ({ id: kind, kind })),
  edges: [...chain(quickTaskOrder), { from: "quality", to: "work", loop: true }],
};

export const FLOW_TEMPLATES: Readonly<Record<FlowTemplateName, FlowTemplate>> = {
  quick: {
    name: "quick",
    summary:
      "One implementer task, deterministic quality gates, no model review; for small, low-risk edits.",
    run: quickRun,
    task: quickTask,
    strategy: { explore: "strategy", advisor: "off", planGate: "off" },
    triage: { stopAfterIdenticalFailures: 2 },
  },
  standard: {
    name: "standard",
    summary:
      "Intake, architect plan, parallel implementation with independent review and test, final decision.",
    run: standardRun,
    task: standardTask,
    strategy: { explore: "strategy", advisor: "strategy", planGate: "strategy" },
    triage: {},
  },
  full: {
    name: "full",
    summary:
      "Standard plus read-only exploration, a plan approval gate and architect advice before the final decision.",
    run: standardRun,
    task: standardTask,
    strategy: { explore: "force", advisor: "force", planGate: "force" },
    triage: {},
  },
};

export function flowTemplate(name: FlowTemplateName): FlowTemplate {
  return FLOW_TEMPLATES[name];
}
