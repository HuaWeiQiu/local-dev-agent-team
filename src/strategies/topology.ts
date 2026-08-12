import type {
  ApprovalGate,
  StrategyTopologyMode,
  WorkflowRole,
} from "../config/schema.js";

export type StrategyStageKind =
  | "agent"
  | "worker-pool"
  | "quality-gate"
  | "human-approval"
  | "publication";

export interface CompiledStrategyStage {
  id: string;
  kind: StrategyStageKind;
  label: string;
  roles: WorkflowRole[];
}

export interface CompiledStrategyEdge {
  source: string;
  target: string;
}

export interface CompiledStrategyTopology {
  version: 1;
  mode: StrategyTopologyMode;
  stages: CompiledStrategyStage[];
  edges: CompiledStrategyEdge[];
}

export function compileStrategyTopology(
  mode: StrategyTopologyMode,
  approvalGates: ApprovalGate[],
  options?: { exploreEnabled?: boolean },
): CompiledStrategyTopology {
  const stages: CompiledStrategyStage[] = [
    stage("intake", "agent", "目标分析", ["orchestrator"]),
  ];
  if (options?.exploreEnabled) {
    stages.push(stage("explore", "agent", "代码探索", ["architect"]));
  }
  stages.push(stage("architecture", "agent", "任务规划", ["architect"]));
  if (approvalGates.includes("plan")) {
    stages.push(stage("plan-approval", "human-approval", "计划审批"));
  }
  stages.push(
    stage("task-execution", "worker-pool", mode === "sequential" ? "串行执行" : "并行执行（Swarm 波次）", [
      "worker",
      "reviewer",
      "tester",
    ]),
    stage("integration-quality", "quality-gate", "集成质量门禁"),
    stage("final-decision", "agent", "交付决策", ["orchestrator"]),
    stage("final-approval", "human-approval", "交付审批"),
    stage("publication", "publication", "发布边界"),
  );

  return {
    version: 1,
    mode,
    stages,
    edges: stages.slice(1).map((current, index) => ({
      source: stages[index]!.id,
      target: current.id,
    })),
  };
}

function stage(
  id: string,
  kind: StrategyStageKind,
  label: string,
  roles: WorkflowRole[] = [],
): CompiledStrategyStage {
  return { id, kind, label, roles };
}
