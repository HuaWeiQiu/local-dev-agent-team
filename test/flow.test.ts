import { describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  FlowValidationError,
  applyTemplateToStrategy,
  flowFactsFor,
  foldFlowEvents,
  orderedNodes,
  routeTemplate,
  runFlow,
  validateTemplate,
  type FlowNodeEvent,
  type FlowTemplate,
  type RunNodeKind,
} from "../src/flow/index.js";
import type { RunEvent } from "../src/events/types.js";
import type { ResolvedStrategy } from "../src/strategies/resolve.js";
import { compileStrategyTopology } from "../src/strategies/topology.js";

const strategy: ResolvedStrategy = {
  name: "default",
  maxParallel: 2,
  maxReworkAttempts: 2,
  executionTimeoutSeconds: 3600,
  maxAgentInvocations: 64,
  maxProcessOutputBytes: 1_000_000,
  maxArtifactBytes: 1_000_000_000,
  roleProfiles: {},
  approvalGates: ["final"],
  approvalTimeoutSeconds: 600,
  topology: compileStrategyTopology("parallel-dag", ["final"], { exploreEnabled: false }),
  swarmMaxConcurrency: 2,
  explore: { enabled: false, maxInjectedChars: 4000, failOpen: true },
  advisor: { enabled: false, triggers: ["repeated-failure", "pre-final"], maxConsultationsPerRun: 3 },
};

function cloneTemplate(name: keyof typeof FLOW_TEMPLATES): FlowTemplate {
  return structuredClone(FLOW_TEMPLATES[name]);
}

describe("flow templates", () => {
  it.each(["quick", "standard", "full"] as const)("%s is a valid template", (name) => {
    expect(() => validateTemplate(FLOW_TEMPLATES[name])).not.toThrow();
  });

  it("refuses a template that drops the final approval", () => {
    const template = cloneTemplate("quick");
    template.run.nodes = template.run.nodes.filter((node) => node.id !== "approve-final");
    template.run.edges = template.run.edges.filter((edge) => edge.to !== "approve-final");
    expect(() => validateTemplate(template)).toThrow(/approve-final/);
  });

  it("refuses a template that drops or conditions the quality gate", () => {
    const missing = cloneTemplate("standard");
    missing.task.nodes = missing.task.nodes.filter((node) => node.id !== "quality");
    missing.task.edges = [
      { from: "work", to: "review" },
      { from: "review", to: "test" },
      { from: "test", to: "commit" },
    ];
    expect(() => validateTemplate(missing)).toThrow(FlowValidationError);

    const conditional = cloneTemplate("standard");
    conditional.task.nodes.find((node) => node.id === "quality")!.when = { all: [{ fact: "evaluation" }] };
    expect(() => validateTemplate(conditional)).toThrow(/cannot be conditional/);
  });

  it("refuses review without test, unreachable nodes, cycles and unknown facts", () => {
    const half = cloneTemplate("standard");
    half.task.nodes = half.task.nodes.filter((node) => node.id !== "test");
    half.task.edges = [
      { from: "work", to: "quality" },
      { from: "quality", to: "review" },
      { from: "review", to: "commit" },
    ];
    expect(() => validateTemplate(half)).toThrow(/include both or neither/);

    const orphan = cloneTemplate("quick");
    orphan.run.nodes.push({ id: "advise", kind: "advise" });
    expect(() => validateTemplate(orphan)).toThrow(/unreachable/);

    const cyclic = cloneTemplate("standard");
    cyclic.run.edges.push({ from: "decide", to: "plan" });
    expect(() => validateTemplate(cyclic)).toThrow();

    const unknown = cloneTemplate("standard");
    unknown.run.nodes.find((node) => node.id === "explore")!.when = {
      all: [{ fact: "madeUp" as never }],
    };
    expect(() => validateTemplate(unknown)).toThrow(/unknown fact/);
  });

  it("keeps the quick flow free of model review and architect nodes", () => {
    const quick = FLOW_TEMPLATES.quick;
    expect(orderedNodes(quick.run).map((node) => node.id)).toEqual([
      "plan",
      "execute",
      "final-checks",
      "decide",
      "approve-final",
    ]);
    expect(quick.task.nodes.map((node) => node.id)).toEqual(["work", "quality", "commit"]);
  });
});

describe("template router", () => {
  const route = (goal: string, rest: Partial<Parameters<typeof routeTemplate>[0]> = {}) =>
    routeTemplate({ goal, ...rest });

  it("sends small low-risk edits to the quick flow", () => {
    expect(route("Fix the typo in the README heading").template).toBe("quick");
    expect(route("修复 README 里的拼写错误").template).toBe("quick");
  });

  it("uses the full flow for sensitive or sprawling goals", () => {
    expect(route("Migrate the database schema to add tenant ids").template).toBe("full");
    expect(route("重构鉴权模块").template).toBe("full");
    expect(route("Deliver:\n- T1 api\n- T2 ui\n- T3 docs\n- T4 tests").template).toBe("full");
    expect(route("x".repeat(1600)).template).toBe("full");
  });

  it("counts a repeated task id once", () => {
    expect(route("Implement T1-T2. T1 add src/greet.js. T2 write CHANGELOG.md.").template).toBe("standard");
  });

  it("defaults to the standard flow and explains why", () => {
    const result = route("Add pagination to the run list endpoint");
    expect(result).toMatchObject({ template: "standard", source: "router", engine: "v2" });
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("does not shrink a risky goal just because it mentions docs", () => {
    expect(route("Update the docs for the new auth flow").template).toBe("full");
  });

  it("lets the operator, configuration and evaluations take precedence in that order", () => {
    expect(route("Migrate the database", { override: "quick" })).toMatchObject({ template: "quick", source: "user" });
    expect(route("Fix typo", { configured: "full" })).toMatchObject({ template: "full", source: "config" });
    expect(route("Fix typo", { configured: "auto" }).template).toBe("quick");
    expect(route("Fix typo", { override: "quick", evaluation: true })).toMatchObject({
      template: "standard",
      source: "evaluation",
    });
  });

  it("is deterministic", () => {
    const goal = "Rename the helper and update the comment";
    expect(route(goal)).toEqual(route(goal));
  });
});

describe("template strategy overlay", () => {
  it("leaves the standard flow's strategy untouched", () => {
    expect(applyTemplateToStrategy(strategy, FLOW_TEMPLATES.standard)).toMatchObject({
      approvalGates: ["final"],
      explore: { enabled: false },
      advisor: { enabled: false },
    });
  });

  it("forces exploration, advice and the plan gate for the full flow without touching budgets", () => {
    const result = applyTemplateToStrategy(strategy, FLOW_TEMPLATES.full);
    expect(result.approvalGates).toEqual(["plan", "final"]);
    expect(result.explore.enabled).toBe(true);
    expect(result.advisor?.enabled).toBe(true);
    expect(result.topology.stages.map((stage) => stage.id)).toContain("plan-approval");
    expect(result.maxAgentInvocations).toBe(strategy.maxAgentInvocations);
    expect(result.executionTimeoutSeconds).toBe(strategy.executionTimeoutSeconds);
  });

  it("drops plan approval and advice for the quick flow but keeps final approval", () => {
    const heavy = {
      ...strategy,
      approvalGates: ["plan", "final"] as ResolvedStrategy["approvalGates"],
      advisor: { enabled: true, triggers: ["pre-final"] as never, maxConsultationsPerRun: 2 },
    };
    const result = applyTemplateToStrategy(heavy, FLOW_TEMPLATES.quick);
    expect(result.approvalGates).toEqual(["final"]);
    expect(result.advisor?.enabled).toBe(false);
  });

  it("derives facts from the effective strategy", () => {
    const facts = flowFactsFor(applyTemplateToStrategy(strategy, FLOW_TEMPLATES.full), {
      needsArchitect: true,
      evaluation: false,
    });
    expect(facts).toEqual({
      needsArchitect: true,
      exploreEnabled: true,
      planGate: true,
      advisorPreFinal: true,
      evaluation: false,
    });
  });
});

describe("runFlow", () => {
  const facts = {
    needsArchitect: true,
    exploreEnabled: false,
    planGate: true,
    advisorPreFinal: false,
    evaluation: false,
  };

  function handlers(visited: string[], park?: RunNodeKind) {
    return Object.fromEntries(
      (["intake", "explore", "plan", "approve-plan", "execute", "final-checks", "advise", "decide", "approve-final"] as const).map(
        (kind) => [
          kind,
          async () => {
            visited.push(kind);
            return kind === park ? ("park" as const) : ("done" as const);
          },
        ],
      ),
    );
  }

  it("skips nodes whose conditions fail and reports every transition", async () => {
    const visited: string[] = [];
    const events: FlowNodeEvent[] = [];
    const result = await runFlow(FLOW_TEMPLATES.standard.run, {
      facts,
      handlers: handlers(visited),
      onNode: (event) => void events.push(event),
    });
    expect(result.status).toBe("completed");
    expect(visited).toEqual(["intake", "plan", "approve-plan", "execute", "final-checks", "decide", "approve-final"]);
    expect(events.filter((event) => event.status === "skipped").map((event) => event.nodeId)).toEqual([
      "explore",
      "advise",
    ]);
  });

  it("parks at an approval and resumes after it", async () => {
    const visited: string[] = [];
    const first = await runFlow(FLOW_TEMPLATES.standard.run, { facts, handlers: handlers(visited, "approve-plan") });
    expect(first).toEqual({ status: "parked", lastNode: "approve-plan" });
    const second = await runFlow(
      FLOW_TEMPLATES.standard.run,
      { facts, handlers: handlers(visited) },
      { startAt: "execute" },
    );
    expect(second.status).toBe("completed");
    expect(visited.slice(-4)).toEqual(["execute", "final-checks", "decide", "approve-final"]);
  });

  it("reports a failing node and rethrows", async () => {
    const events: FlowNodeEvent[] = [];
    const failing = handlers([]);
    failing.execute = async () => {
      throw new Error("worker exploded");
    };
    await expect(
      runFlow(FLOW_TEMPLATES.standard.run, { facts, handlers: failing, onNode: (event) => void events.push(event) }),
    ).rejects.toThrow("worker exploded");
    expect(events.at(-1)).toEqual({ nodeId: "execute", status: "failed", reason: "worker exploded" });
  });

  it("rejects an unknown entry node", async () => {
    await expect(
      runFlow(FLOW_TEMPLATES.quick.run, { facts, handlers: handlers([]) }, { startAt: "intake" }),
    ).rejects.toThrow(/unknown node/);
  });
});

describe("foldFlowEvents", () => {
  const event = (sequence: number, type: string, payload: unknown): RunEvent => ({
    id: `e${sequence}`,
    schemaVersion: 1,
    runId: "run-1",
    type,
    occurredAt: `2026-10-03T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload,
    sequence,
    traceId: "t",
    spanId: "s",
  });

  it("rebuilds node progress, attempts and the current node from the ledger", () => {
    const selection = { template: "standard", source: "router", reasons: ["r"], engine: "v2" };
    const progress = foldFlowEvents([
      event(3, "flow.node", { nodeId: "plan", status: "completed" }),
      event(1, "flow.selected", selection),
      event(2, "flow.node", { nodeId: "plan", status: "started" }),
      event(4, "flow.node", { nodeId: "approve-plan", status: "started" }),
      event(5, "flow.node", { nodeId: "approve-plan", status: "parked" }),
      event(6, "run.updated", {}),
      event(7, "flow.node", { nodeId: "execute", status: "started" }),
      event(8, "flow.node", { nodeId: "execute", status: "failed", reason: "boom" }),
      event(9, "flow.node", { nodeId: "execute", status: "started" }),
    ]);
    expect(progress.selection).toEqual(selection);
    expect(progress.nodes.map((node) => [node.nodeId, node.status, node.attempts])).toEqual([
      ["plan", "completed", 1],
      ["approve-plan", "parked", 1],
      ["execute", "started", 2],
    ]);
    expect(progress.current).toBe("execute");
    expect(progress.nodes[2]!.reason).toBeUndefined();
  });

  it("is a pure function of the events", () => {
    const events = [event(1, "flow.node", { nodeId: "plan", status: "started" })];
    expect(foldFlowEvents(events)).toEqual(foldFlowEvents([...events]));
  });
});
