import { describe, expect, it } from "vitest";
import {
  blueprintNameFor,
  buildBlueprintDefinition,
  buildPreviewTopology,
  buildStrategyGraph,
  createDraft,
  sameDraft,
  stageKindLabel,
  topologyModeLabel,
} from "../../web/src/components/strategy/draft.js";
import type {
  CompiledStrategyTopology,
  PublicConfig,
  StrategyDefinition,
} from "../../web/src/types.js";

function config(): PublicConfig {
  return { project: { name: "demo", maxParallel: 4 }, roles: {}, strategies: { default: "demo", definitions: {} } } as unknown as PublicConfig;
}

function compiledTopology(): CompiledStrategyTopology {
  return {
    mode: "parallel-dag",
    stages: [
      { id: "plan", label: "计划", kind: "plan", role: "architect" },
      { id: "build", label: "构建", kind: "work", role: "worker" },
      { id: "review", label: "评审", kind: "review", role: "reviewer" },
    ],
    edges: [{ source: "plan", target: "build" }],
  } as unknown as CompiledStrategyTopology;
}

function definition(patch: Partial<StrategyDefinition> = {}): StrategyDefinition {
  return {
    compiledTopology: compiledTopology(),
    source: "config",
    roleProfiles: { worker: "p1" },
    ...patch,
  } as StrategyDefinition;
}

describe("createDraft", () => {
  it("falls back to documented defaults", () => {
    const draft = createDraft(definition(), config());
    expect(draft).toMatchObject({
      mode: "parallel-dag",
      maxParallel: 4,
      maxReworkAttempts: 0,
      maxAgentInvocations: 64,
      executionTimeoutSeconds: 14_400,
      approvalTimeoutSeconds: 86_400,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      planApproval: false,
      exploreEnabled: false,
      advisorEnabled: false,
      advisorMaxConsultations: 3,
      swarmMaxConcurrency: 4,
      roleProfiles: { worker: "p1" },
    });
  });

  it("keeps explicit values and clamps the swarm to the parallel budget", () => {
    const draft = createDraft(
      definition({
        maxParallel: 2,
        maxReworkAttempts: 3,
        approvalGates: ["plan", "final"],
        topology: { mode: "sequential" },
        taskMorphology: {
          explore: { enabled: true },
          advisor: { enabled: true, maxConsultationsPerRun: 5 },
          implement: { role: "worker", swarm: { maxConcurrency: 8 } },
        },
      } as unknown as Partial<StrategyDefinition>),
      config(),
    );
    expect(draft.mode).toBe("sequential");
    expect(draft.maxReworkAttempts).toBe(3);
    expect(draft.planApproval).toBe(true);
    expect(draft.exploreEnabled).toBe(true);
    expect(draft.advisorEnabled).toBe(true);
    expect(draft.advisorMaxConsultations).toBe(5);
    expect(draft.swarmMaxConcurrency).toBe(2);
  });
});

describe("buildBlueprintDefinition", () => {
  it("pins a sequential draft to a single worker", () => {
    const draft = { ...createDraft(definition(), config()), mode: "sequential" as const, maxParallel: 6, swarmMaxConcurrency: 6 };
    const blueprint = buildBlueprintDefinition(definition(), draft);
    expect(blueprint.maxParallel).toBe(1);
    expect(blueprint.taskMorphology?.implement?.swarm?.maxConcurrency).toBe(1);
    expect(blueprint.topology).toEqual({ mode: "sequential" });
  });

  it("keeps a parallel draft's concurrency and approval gates", () => {
    const draft = { ...createDraft(definition(), config()), maxParallel: 3, swarmMaxConcurrency: 5, planApproval: true };
    const blueprint = buildBlueprintDefinition(definition(), draft);
    expect(blueprint.maxParallel).toBe(3);
    expect(blueprint.taskMorphology?.implement?.swarm?.maxConcurrency).toBe(3);
    expect(blueprint.approvalGates).toEqual(["plan", "final"]);
    expect(blueprint.roleProfiles).toEqual({ worker: "p1" });
  });

  it("keeps an existing advisor block while the operator turns it off", () => {
    const base = definition({
      taskMorphology: {
        advisor: { enabled: true, maxConsultationsPerRun: 2, triggers: ["plan"] },
        explore: { enabled: true, maxInjectedChars: 1_000, failOpen: false, profile: "fast" },
      },
    } as unknown as Partial<StrategyDefinition>);
    const draft = { ...createDraft(base, config()), advisorEnabled: false, exploreEnabled: false };
    const blueprint = buildBlueprintDefinition(base, draft);
    // Turning the advisor off keeps the existing block and the draft's limit.
    expect(blueprint.taskMorphology?.advisor).toMatchObject({ enabled: false, triggers: ["plan"] });
    expect(blueprint.taskMorphology?.advisor?.maxConsultationsPerRun).toBe(
      draft.advisorMaxConsultations,
    );
    expect(blueprint.taskMorphology?.explore).toMatchObject({
      enabled: false,
      maxInjectedChars: 1_000,
      failOpen: false,
      profile: "fast",
    });
  });

  it("does not invent an advisor block when there was none", () => {
    const draft = createDraft(definition(), config());
    expect(buildBlueprintDefinition(definition(), draft).taskMorphology?.advisor).toBeUndefined();
  });
});

describe("draft helpers", () => {
  it("names blueprints by source", () => {
    expect(blueprintNameFor("fast", definition())).toBe("fast-custom");
    expect(blueprintNameFor("fast", definition({ source: "custom" }))).toBe("fast");
  });

  it("compares drafts field by field", () => {
    const draft = createDraft(definition(), config());
    expect(sameDraft(draft, { ...draft })).toBe(true);
    expect(sameDraft(draft, { ...draft, maxParallel: 9 })).toBe(false);
    expect(sameDraft(draft, { ...draft, roleProfiles: { worker: "p2" } })).toBe(false);
    expect(sameDraft(draft, { ...draft, roleProfiles: { worker: "p1", extra: "x" } })).toBe(false);
  });

  it("labels topology modes and stage kinds", () => {
    expect(topologyModeLabel("sequential")).toBeTruthy();
    expect(topologyModeLabel("parallel-dag")).toBeTruthy();
    expect(stageKindLabel("agent" as never)).toBeTruthy();
  });

  it("builds a preview topology and a react-flow graph", () => {
    const preview = buildPreviewTopology(compiledTopology(), createDraft(definition(), config()));
    expect(preview.mode).toBeTruthy();
    expect(preview.stages.length).toBeGreaterThan(0);

    const graph = buildStrategyGraph(compiledTopology(), false, "#fff");
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes[0]?.data).toBeTruthy();

    const compact = buildStrategyGraph(compiledTopology(), true, "#fff");
    expect(compact.nodes).toHaveLength(3);
  });

  it("inserts the explore and plan-approval stages only when the draft asks", () => {
    const withIntake = {
      ...compiledTopology(),
      stages: [{ id: "intake", label: "接单", kind: "agent", role: "orchestrator" }, ...compiledTopology().stages],
    } as CompiledStrategyTopology;
    const draft = createDraft(definition(), config());

    const explore = buildPreviewTopology(withIntake, { ...draft, exploreEnabled: true });
    expect(explore.stages.some((stage) => stage.id === "explore")).toBe(true);

    const approval = buildPreviewTopology(withIntake, { ...draft, planApproval: true });
    expect(approval.stages.some((stage) => stage.id === "plan-approval")).toBe(true);

    const plain = buildPreviewTopology(withIntake, draft);
    expect(plain.stages.some((stage) => stage.id === "explore" || stage.id === "plan-approval")).toBe(false);
  });
});
