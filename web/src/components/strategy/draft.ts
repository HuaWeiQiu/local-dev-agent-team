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

export function createDraft(definition: StrategyDefinition, config: PublicConfig): StrategyDraft {
  const maxParallel = definition.maxParallel ?? config.project.maxParallel;
  const swarm = definition.taskMorphology?.implement?.swarm?.maxConcurrency ?? maxParallel;
  return {
    mode: definition.topology?.mode ?? definition.compiledTopology.mode,
    maxParallel,
    maxReworkAttempts: definition.maxReworkAttempts ?? 0,
    maxAgentInvocations: definition.maxAgentInvocations ?? 64,
    executionTimeoutSeconds: definition.executionTimeoutSeconds ?? 14_400,
    approvalTimeoutSeconds: definition.approvalTimeoutSeconds ?? 86_400,
    maxProcessOutputBytes: definition.maxProcessOutputBytes ?? 1_048_576,
    maxArtifactBytes: definition.maxArtifactBytes ?? 1_073_741_824,
    planApproval: definition.approvalGates?.includes("plan") ?? false,
    exploreEnabled: definition.taskMorphology?.explore?.enabled === true,
    advisorEnabled: definition.taskMorphology?.advisor?.enabled === true,
    advisorMaxConsultations: definition.taskMorphology?.advisor?.maxConsultationsPerRun ?? 3,
    swarmMaxConcurrency: Math.min(swarm, maxParallel),
    roleProfiles: { ...(definition.roleProfiles ?? {}) },
  };
}

export function buildBlueprintDefinition(
  definition: StrategyDefinition,
  draft: StrategyDraft,
): StrategyBlueprintDefinition {
  const { compiledTopology: _compiledTopology, source: _source, ...persisted } = definition;
  const maxParallel = draft.mode === "sequential" ? 1 : draft.maxParallel;
  const swarmMaxConcurrency = draft.mode === "sequential"
    ? 1
    : Math.min(draft.swarmMaxConcurrency, maxParallel);
  return {
    ...persisted,
    topology: { mode: draft.mode },
    maxParallel,
    maxReworkAttempts: draft.maxReworkAttempts,
    maxAgentInvocations: draft.maxAgentInvocations,
    executionTimeoutSeconds: draft.executionTimeoutSeconds,
    approvalTimeoutSeconds: draft.approvalTimeoutSeconds,
    maxProcessOutputBytes: draft.maxProcessOutputBytes,
    maxArtifactBytes: draft.maxArtifactBytes,
    roleProfiles: { ...draft.roleProfiles },
    approvalGates: draft.planApproval ? ["plan", "final"] : ["final"],
    taskMorphology: {
      explore: {
        enabled: draft.exploreEnabled,
        maxInjectedChars: definition.taskMorphology?.explore?.maxInjectedChars ?? 4_000,
        failOpen: definition.taskMorphology?.explore?.failOpen ?? true,
        ...(definition.taskMorphology?.explore?.profile
          ? { profile: definition.taskMorphology.explore.profile }
          : {}),
      },
      // Keep an existing advisor block (triggers/profile) even while it is off;
      // only create one when the operator turns it on.
      ...(draft.advisorEnabled || definition.taskMorphology?.advisor
        ? {
            advisor: {
              ...definition.taskMorphology?.advisor,
              enabled: draft.advisorEnabled,
              maxConsultationsPerRun: draft.advisorMaxConsultations,
            },
          }
        : {}),
      plan: { role: "architect" },
      implement: {
        role: "worker",
        swarm: { maxConcurrency: swarmMaxConcurrency },
      },
    },
  };
}

export function blueprintNameFor(name: string, definition: StrategyDefinition): string {
  return definition.source === "custom" ? name : `${name}-custom`;
}

export function sameDraft(left: StrategyDraft, right: StrategyDraft): boolean {
  if (
    left.mode !== right.mode ||
    left.maxParallel !== right.maxParallel ||
    left.maxReworkAttempts !== right.maxReworkAttempts ||
    left.maxAgentInvocations !== right.maxAgentInvocations ||
    left.executionTimeoutSeconds !== right.executionTimeoutSeconds ||
    left.approvalTimeoutSeconds !== right.approvalTimeoutSeconds ||
    left.maxProcessOutputBytes !== right.maxProcessOutputBytes ||
    left.maxArtifactBytes !== right.maxArtifactBytes ||
    left.planApproval !== right.planApproval ||
    left.exploreEnabled !== right.exploreEnabled ||
    left.advisorEnabled !== right.advisorEnabled ||
    left.advisorMaxConsultations !== right.advisorMaxConsultations ||
    left.swarmMaxConcurrency !== right.swarmMaxConcurrency
  ) {
    return false;
  }
  const roles = new Set([
    ...Object.keys(left.roleProfiles),
    ...Object.keys(right.roleProfiles),
  ]);
  return [...roles].every((role) => left.roleProfiles[role] === right.roleProfiles[role]);
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
