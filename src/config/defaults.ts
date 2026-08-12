import type { AgentTeamConfig } from "./schema.js";

export function createDefaultConfig(projectName: string): AgentTeamConfig {
  return {
    version: 1,
    project: {
      name: projectName,
      defaultBranch: "main",
      stateDirectory: ".agent-team",
      maxParallel: 2,
    },
    profiles: {
      "codex-planner": {
        adapter: "codex",
        model: "inherit",
        reasoning: "high",
        permission: "read-only",
        externalTools: "deny",
        timeoutSeconds: 900,
        args: [],
      },
      "codex-worker": {
        adapter: "codex",
        model: "inherit",
        reasoning: "medium",
        permission: "workspace-write",
        externalTools: "deny",
        timeoutSeconds: 1800,
        args: [],
      },
    },
    roles: {
      orchestrator: {
        defaultProfile: "codex-planner",
        allowedProfiles: ["codex-planner"],
        fallbackProfiles: [],
      },
      architect: {
        defaultProfile: "codex-planner",
        allowedProfiles: ["codex-planner"],
        fallbackProfiles: [],
      },
      worker: {
        defaultProfile: "codex-worker",
        allowedProfiles: ["codex-worker"],
        fallbackProfiles: [],
      },
      reviewer: {
        defaultProfile: "codex-planner",
        allowedProfiles: ["codex-planner"],
        fallbackProfiles: [],
      },
      tester: {
        defaultProfile: "codex-planner",
        allowedProfiles: ["codex-planner"],
        fallbackProfiles: [],
      },
    },
    strategies: {
      default: "balanced",
      definitions: {
        balanced: {
          topology: { mode: "parallel-dag" },
          maxParallel: 2,
          maxReworkAttempts: 2,
          executionTimeoutSeconds: 14_400,
          maxAgentInvocations: 64,
          maxProcessOutputBytes: 1_048_576,
          maxArtifactBytes: 1_073_741_824,
          roleProfiles: {},
          approvalGates: ["final"],
          approvalTimeoutSeconds: 86_400,
        },
      },
    },
    observability: {
      maxEventsPerRun: 50_000,
    },
    experience: {
      enabled: true,
      injectIntoPlanning: true,
      injectIntoRework: true,
      extractOnTerminal: true,
      maxInjected: 8,
      requireSuiteForPromote: false,
      autoPromoteWithSuite: true,
      recordAttemptCards: true,
      writeStrategyHints: true,
    },
    evolution: {
      automatic: {
        enabled: false,
        autoStart: false,
        maxCycles: 3,
        maxConsecutiveNoImprovement: 2,
        evaluationRepeats: 1,
        minimumScoreDelta: 1,
        proposerRole: "orchestrator",
        targetStrategy: "auto-evolved",
        evaluationGoal: "",
      },
    },
    quality: {
      commands: [],
      maxReworkAttempts: 2,
      commandTimeoutSeconds: 900,
    },
    github: {
      enabled: true,
      remote: "origin",
      draftPullRequest: true,
      autoMerge: false,
      checkTimeoutSeconds: 1_800,
      maxRepairAttempts: 1,
      repairForbiddenPaths: [".github/workflows/**", "agent-team.yaml"],
    },
  };
}
