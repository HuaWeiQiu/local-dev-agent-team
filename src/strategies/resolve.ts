import type {
  AdvisorTrigger,
  AgentTeamConfig,
  ApprovalGate,
  NamedStrategy,
} from "../config/schema.js";
import { compileStrategyTopology, type CompiledStrategyTopology } from "./topology.js";

export interface ResolvedAdvisorMorphology {
  enabled: boolean;
  triggers: AdvisorTrigger[];
  maxConsultationsPerRun: number;
  profile?: string;
}

const disabledAdvisor: ResolvedAdvisorMorphology = {
  enabled: false,
  triggers: ["repeated-failure", "pre-final"],
  maxConsultationsPerRun: 3,
};

export interface ResolvedExploreMorphology {
  enabled: boolean;
  profile?: string;
  maxInjectedChars: number;
  failOpen: boolean;
}

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
  /** Effective wave concurrency: min(swarm.maxConcurrency, maxParallel). */
  swarmMaxConcurrency: number;
  explore: ResolvedExploreMorphology;
  /** Absent on runs persisted before the advisor existed; treat as disabled. */
  advisor?: ResolvedAdvisorMorphology;
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
      topology: compileStrategyTopology("parallel-dag", ["final"], { exploreEnabled: false }),
      swarmMaxConcurrency: config.project.maxParallel,
      explore: { enabled: false, maxInjectedChars: 4_000, failOpen: true },
      advisor: { ...disabledAdvisor, triggers: [...disabledAdvisor.triggers] },
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

  return resolveNamedStrategy(config, name, strategy);
}

function resolveNamedStrategy(
  config: AgentTeamConfig,
  name: string,
  strategy: NamedStrategy,
): ResolvedStrategy {
  const approvalGates: ApprovalGate[] = strategy.approvalGates
    ? [...strategy.approvalGates]
    : ["final"];
  const topologyMode = strategy.topology?.mode ?? "parallel-dag";
  const maxParallel = topologyMode === "sequential"
    ? 1
    : strategy.maxParallel ?? config.project.maxParallel;
  const swarmCap = strategy.taskMorphology?.implement?.swarm?.maxConcurrency;
  const swarmMaxConcurrency = Math.min(swarmCap ?? maxParallel, maxParallel);
  const exploreConfig = strategy.taskMorphology?.explore;
  const explore: ResolvedExploreMorphology = {
    enabled: exploreConfig?.enabled ?? false,
    maxInjectedChars: exploreConfig?.maxInjectedChars ?? 4_000,
    failOpen: exploreConfig?.failOpen ?? true,
    ...(exploreConfig?.profile ? { profile: exploreConfig.profile } : {}),
  };
  const advisorConfig = strategy.taskMorphology?.advisor;
  const advisor: ResolvedAdvisorMorphology = advisorConfig
    ? {
        enabled: advisorConfig.enabled,
        triggers: [...advisorConfig.triggers],
        maxConsultationsPerRun: advisorConfig.maxConsultationsPerRun,
        ...(advisorConfig.profile ? { profile: advisorConfig.profile } : {}),
      }
    : { ...disabledAdvisor, triggers: [...disabledAdvisor.triggers] };

  return {
    name,
    maxParallel,
    maxReworkAttempts:
      strategy.maxReworkAttempts ?? config.quality.maxReworkAttempts,
    executionTimeoutSeconds: strategy.executionTimeoutSeconds ?? 14_400,
    maxAgentInvocations: strategy.maxAgentInvocations ?? 64,
    maxProcessOutputBytes: strategy.maxProcessOutputBytes ?? 1_048_576,
    maxArtifactBytes: strategy.maxArtifactBytes ?? 1_073_741_824,
    roleProfiles: { ...strategy.roleProfiles },
    approvalGates,
    approvalTimeoutSeconds: strategy.approvalTimeoutSeconds ?? 86_400,
    topology: compileStrategyTopology(topologyMode, approvalGates, {
      exploreEnabled: explore.enabled,
    }),
    swarmMaxConcurrency,
    explore,
    advisor,
  };
}
