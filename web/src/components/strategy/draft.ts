import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import { STRATEGY_STAGE_GRID } from "../../graph";
import { topologyDisplayName } from "../../presentation";
import type {
  CompiledStrategyStage,
  CompiledStrategyTopology,
  PublicConfig,
  StrategyBlueprintDefinition,
  StrategyDefinition,
  StrategyTopologyMode,
} from "../../types";

export interface StrategyDraft {
  mode: StrategyTopologyMode;
  maxParallel: number;
  maxReworkAttempts: number;
  maxAgentInvocations: number;
  executionTimeoutSeconds: number;
  approvalTimeoutSeconds: number;
  maxProcessOutputBytes: number;
  maxArtifactBytes: number;
  planApproval: boolean;
  exploreEnabled: boolean;
  advisorEnabled: boolean;
  advisorMaxConsultations: number;
  swarmMaxConcurrency: number;
  roleProfiles: Record<string, string>;
}

export interface StrategyNodeData extends Record<string, unknown> {
  stage: CompiledStrategyStage;
  sourcePosition: Position;
  targetPosition: Position;
}

export interface ComposerFeedback {
  kind: "valid" | "saved" | "error";
  message: string;
}

export type DraftUpdater = (update: (current: StrategyDraft) => StrategyDraft) => void;

/** Defaults for a draft that has never been edited, in one place. */
const DRAFT_DEFAULTS = {
  maxReworkAttempts: 0,
  maxAgentInvocations: 64,
  executionTimeoutSeconds: 14_400,
  approvalTimeoutSeconds: 86_400,
  maxProcessOutputBytes: 1_048_576,
  maxArtifactBytes: 1_073_741_824,
  advisorMaxConsultations: 3,
  exploreMaxInjectedChars: 4_000,
} as const;

export function createDraft(definition: StrategyDefinition, config: PublicConfig): StrategyDraft {
  const maxParallel = orDefault(definition.maxParallel, config.project.maxParallel);
  const swarm = orDefault(swarmConcurrencyOf(definition), maxParallel);
  return {
    mode: topologyModeOf(definition),
    maxParallel,
    maxReworkAttempts: orDefault(definition.maxReworkAttempts, DRAFT_DEFAULTS.maxReworkAttempts),
    maxAgentInvocations: orDefault(definition.maxAgentInvocations, DRAFT_DEFAULTS.maxAgentInvocations),
    executionTimeoutSeconds:
      definition.executionTimeoutSeconds ?? DRAFT_DEFAULTS.executionTimeoutSeconds,
    approvalTimeoutSeconds:
      definition.approvalTimeoutSeconds ?? DRAFT_DEFAULTS.approvalTimeoutSeconds,
    maxProcessOutputBytes:
      definition.maxProcessOutputBytes ?? DRAFT_DEFAULTS.maxProcessOutputBytes,
    maxArtifactBytes: orDefault(definition.maxArtifactBytes, DRAFT_DEFAULTS.maxArtifactBytes),
    planApproval: includesPlanGate(definition),
    exploreEnabled: exploreSettings(definition)?.enabled === true,
    advisorEnabled: advisorSettings(definition)?.enabled === true,
    advisorMaxConsultations: advisorConsultationsOf(definition),
    swarmMaxConcurrency: Math.min(swarm, maxParallel),
    roleProfiles: { ...(definition.roleProfiles ?? {}) },
  };
}

function topologyModeOf(definition: StrategyDefinition): StrategyDefinition["compiledTopology"]["mode"] {
  return definition.topology?.mode ?? definition.compiledTopology.mode;
}

function swarmConcurrencyOf(definition: StrategyDefinition): number | undefined {
  return definition.taskMorphology?.implement?.swarm?.maxConcurrency;
}

function exploreSettings(definition: StrategyDefinition) {
  return definition.taskMorphology?.explore;
}

function advisorSettings(definition: StrategyDefinition) {
  return definition.taskMorphology?.advisor;
}

function includesPlanGate(definition: StrategyDefinition): boolean {
  return definition.approvalGates?.includes("plan") ?? false;
}

function advisorConsultationsOf(definition: StrategyDefinition): number {
  return orDefault(
    advisorSettings(definition)?.maxConsultationsPerRun,
    DRAFT_DEFAULTS.advisorMaxConsultations,
  );
}

/** One fallback rule for the whole module: undefined means "use the default". */
function orDefault<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

export function buildBlueprintDefinition(
  definition: StrategyDefinition,
  draft: StrategyDraft,
): StrategyBlueprintDefinition {
  const { compiledTopology: _compiledTopology, source: _source, ...persisted } = definition;
  return {
    ...persisted,
    topology: { mode: draft.mode },
    ...swarmLimits(draft),
    maxReworkAttempts: draft.maxReworkAttempts,
    maxAgentInvocations: draft.maxAgentInvocations,
    executionTimeoutSeconds: draft.executionTimeoutSeconds,
    approvalTimeoutSeconds: draft.approvalTimeoutSeconds,
    maxProcessOutputBytes: draft.maxProcessOutputBytes,
    maxArtifactBytes: draft.maxArtifactBytes,
    roleProfiles: { ...draft.roleProfiles },
    approvalGates: draft.planApproval ? ["plan", "final"] : ["final"],
    taskMorphology: {
      explore: exploreBlock(definition, draft),
      ...withAdvisor(definition, draft),
      plan: { role: "architect" },
      implement: {
        role: "worker",
        swarm: { maxConcurrency: concurrencyFor(draft) },
      },
    },
  };
}

/** A sequential draft is pinned to one worker, whatever the sliders say. */
function swarmLimits(draft: StrategyDraft): { maxParallel: number } {
  return { maxParallel: draft.mode === "sequential" ? 1 : draft.maxParallel };
}

function concurrencyFor(draft: StrategyDraft): number {
  if (draft.mode === "sequential") return 1;
  return Math.min(draft.swarmMaxConcurrency, draft.maxParallel);
}

function exploreBlock(
  definition: StrategyDefinition,
  draft: StrategyDraft,
): {
  enabled: boolean;
  maxInjectedChars: number;
  failOpen: boolean;
  profile?: string;
} {
  const existing = definition.taskMorphology?.explore;
  return {
    enabled: draft.exploreEnabled,
    maxInjectedChars: existing?.maxInjectedChars ?? DRAFT_DEFAULTS.exploreMaxInjectedChars,
    failOpen: existing?.failOpen ?? true,
    ...(existing?.profile ? { profile: existing.profile } : {}),
  };
}

/** Keep an existing advisor block (triggers/profile) even while it is off. */
function withAdvisor(
  definition: StrategyDefinition,
  draft: StrategyDraft,
): Pick<NonNullable<StrategyBlueprintDefinition["taskMorphology"]>, "advisor"> | Record<string, never> {
  const existing = definition.taskMorphology?.advisor;
  if (!draft.advisorEnabled && !existing) return {};
  return {
    advisor: {
      ...existing,
      enabled: draft.advisorEnabled,
      maxConsultationsPerRun: draft.advisorMaxConsultations,
    },
  };
}

export function blueprintNameFor(name: string, definition: StrategyDefinition): string {
  return definition.source === "custom" ? name : `${name}-custom`;
}

const DRAFT_SCALARS = [
  "mode",
  "maxParallel",
  "maxReworkAttempts",
  "maxAgentInvocations",
  "executionTimeoutSeconds",
  "approvalTimeoutSeconds",
  "maxProcessOutputBytes",
  "maxArtifactBytes",
  "planApproval",
  "exploreEnabled",
  "advisorEnabled",
  "advisorMaxConsultations",
  "swarmMaxConcurrency",
] as const satisfies ReadonlyArray<keyof StrategyDraft>;

export function sameDraft(left: StrategyDraft, right: StrategyDraft): boolean {
  const scalarsEqual = DRAFT_SCALARS.every((key) => left[key] === right[key]);
  return scalarsEqual && sameRoleProfiles(left.roleProfiles, right.roleProfiles);
}

function sameRoleProfiles(
  left: StrategyDraft["roleProfiles"],
  right: StrategyDraft["roleProfiles"],
): boolean {
  const roles = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...roles].every((role) => left[role] === right[role]);
}

export function buildPreviewTopology(
  compiled: CompiledStrategyTopology,
  draft: StrategyDraft,
): CompiledStrategyTopology {
  let stages = compiled.stages.filter(
    (stage) => stage.id !== "plan-approval" && stage.id !== "explore",
  );
  const intakeIndex = stages.findIndex((stage) => stage.id === "intake");
  if (draft.exploreEnabled && intakeIndex >= 0) {
    stages = [
      ...stages.slice(0, intakeIndex + 1),
      { id: "explore", kind: "agent", label: "代码探索", roles: ["architect"] },
      ...stages.slice(intakeIndex + 1),
    ];
  }
  if (draft.planApproval) {
    const architectureIndex = stages.findIndex((stage) => stage.id === "architecture");
    stages = [
      ...stages.slice(0, architectureIndex + 1),
      { id: "plan-approval", kind: "human-approval", label: "计划审批", roles: [] },
      ...stages.slice(architectureIndex + 1),
    ];
  }
  stages = stages.map((stage) => stage.id === "task-execution"
    ? { ...stage, label: draft.mode === "sequential" ? "串行执行" : "并行执行（Swarm 波次）" }
    : stage);
  return {
    version: 1,
    mode: draft.mode,
    stages,
    edges: stages.slice(1).map((stage, index) => ({ source: stages[index]!.id, target: stage.id })),
  };
}

export function buildStrategyGraph(
  topology: CompiledStrategyTopology,
  compact: boolean,
  edgeColor: string,
): { nodes: Array<Node<StrategyNodeData>>; edges: Edge[] } {
  const columns = compact ? 2 : 3;
  const nodes = topology.stages.map((stage, index) => {
    const row = Math.floor(index / columns);
    const offset = index % columns;
    const column = row % 2 === 0 ? offset : columns - 1 - offset;
    const startsRow = offset === 0 && row > 0;
    const endsRow = offset === columns - 1 && index < topology.stages.length - 1;
    const horizontalSource = row % 2 === 0 ? Position.Right : Position.Left;
    const horizontalTarget = row % 2 === 0 ? Position.Left : Position.Right;
    return {
      id: stage.id,
      type: "strategyStage",
      position: {
        x: column * STRATEGY_STAGE_GRID.columnWidth,
        y: row * STRATEGY_STAGE_GRID.rowHeight,
      },
      data: {
        stage,
        sourcePosition: endsRow ? Position.Bottom : horizontalSource,
        targetPosition: startsRow ? Position.Top : horizontalTarget,
      },
    };
  });
  const edges = topology.edges.map((edge) => ({
    id: `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    style: { stroke: edgeColor, strokeWidth: 1.5 },
  }));
  return { nodes, edges };
}

export function topologyModeLabel(mode: StrategyTopologyMode): string {
  return topologyDisplayName(mode);
}

export function stageKindLabel(kind: CompiledStrategyStage["kind"]): string {
  return {
    agent: "角色阶段",
    "worker-pool": "执行池",
    "quality-gate": "质量门禁",
    "human-approval": "人工审批",
    publication: "发布",
  }[kind];
}
