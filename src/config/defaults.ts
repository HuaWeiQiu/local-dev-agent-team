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
        timeoutSeconds: 900,
        args: [],
      },
      "codex-worker": {
        adapter: "codex",
        model: "inherit",
        reasoning: "medium",
        permission: "workspace-write",
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
    },
  };
}
