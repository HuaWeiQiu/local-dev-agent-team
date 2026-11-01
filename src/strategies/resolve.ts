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
  const approvalGates = approvalGatesOf(strategy);
  const explore = resolveExplore(strategy);
  return {
    name,
    maxParallel: maxParallelOf(config, strategy),
    maxReworkAttempts: strategy.maxReworkAttempts ?? config.quality.maxReworkAttempts,
    executionTimeoutSeconds: strategy.executionTimeoutSeconds ?? 14_400,
    maxAgentInvocations: strategy.maxAgentInvocations ?? 64,
    maxProcessOutputBytes: strategy.maxProcessOutputBytes ?? 1_048_576,
    maxArtifactBytes: strategy.maxArtifactBytes ?? 1_073_741_824,
    roleProfiles: { ...strategy.roleProfiles },
    approvalGates,
    approvalTimeoutSeconds: strategy.approvalTimeoutSeconds ?? 86_400,
    topology: compileStrategyTopology(topologyModeOf(strategy), approvalGates, {
      exploreEnabled: explore.enabled,
    }),
    swarmMaxConcurrency: swarmConcurrencyOf(config, strategy),
    explore,
    advisor: resolveAdvisor(strategy),
  };
}

function approvalGatesOf(strategy: NamedStrategy): ApprovalGate[] {
  return strategy.approvalGates ? [...strategy.approvalGates] : ["final"];
}

function topologyModeOf(strategy: NamedStrategy): "sequential" | "parallel-dag" {
  return strategy.topology?.mode ?? "parallel-dag";
}

/** A sequential topology runs one task at a time, whatever else is configured. */
function maxParallelOf(config: AgentTeamConfig, strategy: NamedStrategy): number {
  if (topologyModeOf(strategy) === "sequential") return 1;
  return strategy.maxParallel ?? config.project.maxParallel;
}

/** Swarm concurrency is a cap on the wave size, never a replacement for it. */
function swarmConcurrencyOf(config: AgentTeamConfig, strategy: NamedStrategy): number {
  const maxParallel = maxParallelOf(config, strategy);
  const cap = strategy.taskMorphology?.implement?.swarm?.maxConcurrency;
  return Math.min(cap ?? maxParallel, maxParallel);
}

function resolveExplore(strategy: NamedStrategy): ResolvedExploreMorphology {
  const config = strategy.taskMorphology?.explore;
  return {
    enabled: config?.enabled ?? false,
    maxInjectedChars: config?.maxInjectedChars ?? 4_000,
    failOpen: config?.failOpen ?? true,
    ...profileOf(config),
  };
}

/** A profile is carried only when one is named; absent is not the same as empty. */
function profileOf(config: { profile?: string | undefined } | undefined): { profile?: string } {
  return config?.profile ? { profile: config.profile } : {};
}

/** An unconfigured advisor is disabled, and says so with the default triggers. */
function resolveAdvisor(strategy: NamedStrategy): ResolvedAdvisorMorphology {
  const config = strategy.taskMorphology?.advisor;
  if (!config) return { ...disabledAdvisor, triggers: [...disabledAdvisor.triggers] };
  return {
    enabled: config.enabled,
    triggers: [...config.triggers],
    maxConsultationsPerRun: config.maxConsultationsPerRun,
    ...profileOf(config),
  };
}

