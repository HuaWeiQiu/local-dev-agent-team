import type { AgentTeamConfig, ApprovalGate } from "../config/schema.js";
import { compileStrategyTopology, type CompiledStrategyTopology } from "./topology.js";

export interface ResolvedStrategy {
  name: string;
  maxParallel: number;
  maxReworkAttempts: number;
  executionTimeoutSeconds: number;
  maxAgentInvocations: number;
  maxProcessOutputBytes: number;
  maxArtifactBytes: number;
  roleProfiles: Record<string, string>;
  approvalGates: ApprovalGate[];
  approvalTimeoutSeconds: number;
  topology: CompiledStrategyTopology;
}

export function resolveStrategy(
  config: AgentTeamConfig,
  requestedName?: string,
): ResolvedStrategy {
  if (!config.strategies) {
    if (requestedName) {
      throw new Error(`Unknown strategy '${requestedName}'`);
    }
    return {
      name: "legacy",
      maxParallel: config.project.maxParallel,
      maxReworkAttempts: config.quality.maxReworkAttempts,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
      topology: compileStrategyTopology("parallel-dag", ["final"]),
    };
  }

  const name = requestedName ?? config.strategies.default;
  const strategy = config.strategies.definitions[name];
  if (!strategy) {
    throw new Error(
      `Unknown strategy '${name}'. Available strategies: ${Object.keys(
        config.strategies.definitions,
      ).join(", ")}`,
    );
  }

  const approvalGates: ApprovalGate[] = strategy.approvalGates
    ? [...strategy.approvalGates]
    : ["final"];
  const topologyMode = strategy.topology?.mode ?? "parallel-dag";
  return {
    name,
    maxParallel: topologyMode === "sequential"
      ? 1
      : strategy.maxParallel ?? config.project.maxParallel,
    maxReworkAttempts:
      strategy.maxReworkAttempts ?? config.quality.maxReworkAttempts,
    executionTimeoutSeconds: strategy.executionTimeoutSeconds ?? 14_400,
    maxAgentInvocations: strategy.maxAgentInvocations ?? 64,
    maxProcessOutputBytes: strategy.maxProcessOutputBytes ?? 1_048_576,
    maxArtifactBytes: strategy.maxArtifactBytes ?? 1_073_741_824,
    roleProfiles: { ...strategy.roleProfiles },
    approvalGates,
    approvalTimeoutSeconds: strategy.approvalTimeoutSeconds ?? 86_400,
    topology: compileStrategyTopology(topologyMode, approvalGates),
  };
}
