import type { ResolvedStrategy } from "../strategies/resolve.js";
import { compileStrategyTopology } from "../strategies/topology.js";
import { flowTemplate } from "./templates.js";
import type { FlowFacts, FlowSelection, FlowTemplate, RunGraph, TaskGraph } from "./types.js";

/**
 * Reshapes a resolved strategy for the template. Budgets, concurrency, role
 * profiles and the final approval gate are never touched here.
 */
export function applyTemplateToStrategy(
  strategy: ResolvedStrategy,
  template: FlowTemplate,
): ResolvedStrategy {
  const explore =
    template.strategy.explore === "force"
      ? { ...strategy.explore, enabled: true }
      : strategy.explore;

  const advisorBase = strategy.advisor ?? {
    enabled: false,
    triggers: ["repeated-failure", "pre-final"] as Array<"repeated-failure" | "pre-final">,
    maxConsultationsPerRun: 3,
  };
  const advisor =
    template.strategy.advisor === "force"
      ? { ...advisorBase, enabled: true }
      : template.strategy.advisor === "off"
        ? { ...advisorBase, enabled: false }
        : advisorBase;

  let gates = [...strategy.approvalGates];
  if (template.strategy.planGate === "force" && !gates.includes("plan")) {
    gates = ["plan", ...gates];
  } else if (template.strategy.planGate === "off") {
    gates = gates.filter((gate) => gate !== "plan");
  }

  return {
    ...strategy,
    approvalGates: gates,
    explore,
    advisor,
    topology: compileStrategyTopology(strategy.topology.mode, gates, {
      exploreEnabled: explore.enabled,
    }),
  };
}

export function flowFactsFor(
  strategy: ResolvedStrategy,
  context: { needsArchitect: boolean; evaluation: boolean },
): FlowFacts {
  const advisor = strategy.advisor;
  return {
    needsArchitect: context.needsArchitect,
    exploreEnabled: strategy.explore.enabled,
    planGate: strategy.approvalGates.includes("plan"),
    advisorPreFinal: Boolean(advisor?.enabled && advisor.triggers.includes("pre-final")),
    evaluation: context.evaluation,
  };
}

export interface ActiveFlow {
  selection: FlowSelection;
  template: FlowTemplate;
  run: RunGraph;
  task: TaskGraph;
}

export function activeFlow(selection: FlowSelection): ActiveFlow {
  const template = flowTemplate(selection.template);
  return { selection, template, run: template.run, task: template.task };
}

export function taskStepEnabled(flow: ActiveFlow | undefined, kind: "review" | "test"): boolean {
  if (!flow) return true;
  return flow.task.nodes.some((node) => node.kind === kind);
}
