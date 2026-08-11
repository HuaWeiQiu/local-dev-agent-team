import { z } from "zod";

export const workflowRoles = [
  "orchestrator",
  "architect",
  "worker",
  "reviewer",
  "tester",
] as const;

export const reasoningSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const permissionSchema = z.enum(["read-only", "workspace-write"]);
export const externalToolsSchema = z.enum(["deny", "inherit"]);

export const codexProviderSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Invalid Codex provider ID"),
  name: z.string().min(1).optional(),
  baseUrl: z.url(),
  wireApi: z.literal("responses").default("responses"),
  requiresOpenAIAuth: z.boolean().default(true),
  supportsWebSockets: z.boolean().default(false),
});

export const commandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export const profileSchema = z.object({
  adapter: z.string().min(1),
  executable: z.string().min(1).optional(),
  model: z.string().min(1),
  reasoning: reasoningSchema,
  permission: permissionSchema,
  externalTools: externalToolsSchema.default("deny"),
  nativeProfile: z.string().min(1).optional(),
  codexProvider: codexProviderSchema.optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  timeoutSeconds: z.number().int().positive(),
  args: z.array(z.string()).default([]),
});

export const roleSchema = z.object({
  defaultProfile: z.string().min(1),
  allowedProfiles: z.array(z.string().min(1)).min(1),
  fallbackProfiles: z.array(z.string().min(1)).default([]),
  promptFile: z.string().min(1).optional(),
});

export const approvalGateSchema = z.enum(["plan", "final"]);
export const strategyTopologyModeSchema = z.enum(["parallel-dag", "sequential"]);
export const strategyTopologySchema = z.object({
  mode: strategyTopologyModeSchema.default("parallel-dag"),
});

export const namedStrategySchema = z
  .object({
    topology: strategyTopologySchema.default({ mode: "parallel-dag" }),
    maxParallel: z.number().int().min(1).max(32).optional(),
    maxReworkAttempts: z.number().int().min(0).max(10).optional(),
    executionTimeoutSeconds: z.number().int().min(60).max(604_800).optional(),
    maxAgentInvocations: z.number().int().min(1).max(1_000).optional(),
    maxProcessOutputBytes: z.number().int().min(4_096).max(16_777_216).optional(),
    maxArtifactBytes: z.number().int().min(1_048_576).max(10_737_418_240).optional(),
    roleProfiles: z.record(z.string().min(1), z.string().min(1)).default({}),
    approvalGates: z.array(approvalGateSchema).min(1).max(2).optional(),
    approvalTimeoutSeconds: z.number().int().min(60).max(604_800).optional(),
  })
  .superRefine((strategy, context) => {
    if (strategy.approvalGates && !strategy.approvalGates.includes("final")) {
      context.addIssue({
        code: "custom",
        path: ["approvalGates"],
        message: "Every strategy must include the final approval gate",
      });
    }
    if (
      strategy.approvalGates &&
      new Set(strategy.approvalGates).size !== strategy.approvalGates.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvalGates"],
        message: "Approval gates must be unique",
      });
    }
    if (
      strategy.topology.mode === "sequential" &&
      strategy.maxParallel !== undefined &&
      strategy.maxParallel !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["maxParallel"],
        message: "Sequential strategies require maxParallel to be 1",
      });
    }
  });

export const strategiesSchema = z.object({
  default: z.string().min(1),
  definitions: z.record(z.string().min(1), namedStrategySchema),
});

export const observabilitySchema = z.object({
  maxEventsPerRun: z.number().int().min(100).max(1_000_000).default(50_000),
});

export const automaticEvolutionSchema = z
  .object({
    enabled: z.boolean().default(false),
    autoStart: z.literal(false).default(false),
    maxCycles: z.number().int().min(1).max(10).default(3),
    maxConsecutiveNoImprovement: z.number().int().min(1).max(10).default(2),
    evaluationRepeats: z.number().int().min(1).max(2).default(1),
    minimumScoreDelta: z.number().int().min(0).max(1_000).default(1),
    proposerRole: z.string().min(1).default("orchestrator"),
    proposerProfile: z.string().min(1).optional(),
    baselineStrategy: z.string().min(1).optional(),
    targetStrategy: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
        "Automatic evolution target must be a valid strategy name",
      )
      .default("auto-evolved"),
    evaluationGoal: z.string().trim().max(20_000).default(""),
  })
  .strict()
  .superRefine((automation, context) => {
    if (automation.enabled && !automation.evaluationGoal) {
      context.addIssue({
        code: "custom",
        path: ["evaluationGoal"],
        message: "Enabled automatic evolution requires a fixed evaluationGoal",
      });
    }
    if (automation.maxConsecutiveNoImprovement > automation.maxCycles) {
      context.addIssue({
        code: "custom",
        path: ["maxConsecutiveNoImprovement"],
        message: "Consecutive no-improvement limit cannot exceed maxCycles",
      });
    }
  });

export const evolutionConfigSchema = z.object({
  automatic: automaticEvolutionSchema.default({
    enabled: false,
    autoStart: false,
    maxCycles: 3,
    maxConsecutiveNoImprovement: 2,
    evaluationRepeats: 1,
    minimumScoreDelta: 1,
    proposerRole: "orchestrator",
    targetStrategy: "auto-evolved",
    evaluationGoal: "",
  }),
});

export const configSchema = z
  .object({
    version: z.literal(1),
    project: z.object({
      name: z.string().min(1),
      defaultBranch: z.string().min(1),
      stateDirectory: z.string().min(1),
      maxParallel: z.number().int().min(1).max(32),
    }),
    profiles: z.record(z.string().min(1), profileSchema),
    roles: z.record(z.string().min(1), roleSchema),
    strategies: strategiesSchema.optional(),
    observability: observabilitySchema.default({ maxEventsPerRun: 50_000 }),
    evolution: evolutionConfigSchema.default({
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
    }),
    quality: z.object({
      commands: z.array(commandSchema),
      maxReworkAttempts: z.number().int().min(0).max(10),
      commandTimeoutSeconds: z.number().int().positive(),
    }),
    github: z.object({
      enabled: z.boolean(),
      remote: z.string().min(1),
      draftPullRequest: z.boolean(),
      autoMerge: z.literal(false),
      checkTimeoutSeconds: z.number().int().positive(),
      maxRepairAttempts: z.number().int().min(0).max(5),
      repairForbiddenPaths: z.array(z.string().min(1)),
    }),
  })
  .superRefine((config, context) => {
    if (Object.keys(config.profiles).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["profiles"],
        message: "At least one profile is required",
      });
    }

    for (const roleName of workflowRoles) {
      if (!config.roles[roleName]) {
        context.addIssue({
          code: "custom",
          path: ["roles", roleName],
          message: `Required workflow role '${roleName}' is missing`,
        });
      }
    }

    for (const [roleName, role] of Object.entries(config.roles)) {
      const referenced = [
        role.defaultProfile,
        ...role.allowedProfiles,
        ...role.fallbackProfiles,
      ];
      for (const profileName of referenced) {
        if (!config.profiles[profileName]) {
          context.addIssue({
            code: "custom",
            path: ["roles", roleName],
            message: `Role references unknown profile '${profileName}'`,
          });
        }
      }
      if (!role.allowedProfiles.includes(role.defaultProfile)) {
        context.addIssue({
          code: "custom",
          path: ["roles", roleName, "allowedProfiles"],
          message: "The default profile must also be allowed",
        });
      }
    }

    if (config.strategies) {
      if (!config.strategies.definitions[config.strategies.default]) {
        context.addIssue({
          code: "custom",
          path: ["strategies", "default"],
          message: `Default strategy '${config.strategies.default}' is not defined`,
        });
      }
      for (const [strategyName, strategy] of Object.entries(
        config.strategies.definitions,
      )) {
        for (const [roleName, profileName] of Object.entries(strategy.roleProfiles)) {
          const role = config.roles[roleName];
          if (!role) {
            context.addIssue({
              code: "custom",
              path: ["strategies", "definitions", strategyName, "roleProfiles", roleName],
              message: `Strategy references unknown role '${roleName}'`,
            });
          } else if (!role.allowedProfiles.includes(profileName)) {
            context.addIssue({
              code: "custom",
              path: ["strategies", "definitions", strategyName, "roleProfiles", roleName],
              message: `Profile '${profileName}' is not allowed for role '${roleName}'`,
            });
          }
        }
      }
    }

    const automation = config.evolution.automatic;
    if (automation.enabled) {
      if (config.quality.commands.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["quality", "commands"],
          message: "Enabled automatic evolution requires at least one deterministic quality command",
        });
      }
      const proposerRole = config.roles[automation.proposerRole];
      if (!proposerRole) {
        context.addIssue({
          code: "custom",
          path: ["evolution", "automatic", "proposerRole"],
          message: `Automatic evolution references unknown role '${automation.proposerRole}'`,
        });
      } else {
        const proposerProfile = automation.proposerProfile ?? proposerRole.defaultProfile;
        if (!proposerRole.allowedProfiles.includes(proposerProfile)) {
          context.addIssue({
            code: "custom",
            path: ["evolution", "automatic", "proposerProfile"],
            message: `Profile '${proposerProfile}' is not allowed for role '${automation.proposerRole}'`,
          });
        } else if (config.profiles[proposerProfile]?.permission !== "read-only") {
          context.addIssue({
            code: "custom",
            path: ["evolution", "automatic", "proposerProfile"],
            message: "Automatic evolution proposer must use a read-only profile",
          });
        }
        for (const fallbackProfile of proposerRole.fallbackProfiles) {
          if (config.profiles[fallbackProfile]?.permission === "workspace-write") {
            context.addIssue({
              code: "custom",
              path: ["evolution", "automatic", "proposerRole"],
              message: `Automatic evolution proposer fallback '${fallbackProfile}' must be read-only`,
            });
          }
        }
      }
      const baselineStrategy = automation.baselineStrategy ?? config.strategies?.default;
      if (!baselineStrategy || !config.strategies?.definitions[baselineStrategy]) {
        context.addIssue({
          code: "custom",
          path: ["evolution", "automatic", "baselineStrategy"],
          message: `Automatic evolution baseline strategy '${baselineStrategy ?? ""}' is not defined`,
        });
      }
    }

    for (const [roleName, role] of Object.entries(config.roles)) {
      if (roleName === "worker") continue;
      for (const profileName of new Set([
        role.defaultProfile,
        ...role.allowedProfiles,
        ...role.fallbackProfiles,
      ])) {
        if (config.profiles[profileName]?.permission === "workspace-write") {
          context.addIssue({
            code: "custom",
            path: ["roles", roleName, "allowedProfiles"],
            message: `${roleName} cannot allow workspace-write profile '${profileName}'`,
          });
        }
      }
    }

    for (const [profileName, profile] of Object.entries(config.profiles)) {
      if (profile.nativeProfile && profile.adapter !== "codex") {
        context.addIssue({
          code: "custom",
          path: ["profiles", profileName, "nativeProfile"],
          message: "nativeProfile is supported only by the Codex adapter",
        });
      }
      if (profile.codexProvider && profile.adapter !== "codex") {
        context.addIssue({
          code: "custom",
          path: ["profiles", profileName, "codexProvider"],
          message: "codexProvider is supported only by the Codex adapter",
        });
      }
      if (profile.maxTurns !== undefined && profile.adapter !== "grok") {
        context.addIssue({
          code: "custom",
          path: ["profiles", profileName, "maxTurns"],
          message: "maxTurns is currently supported only by the Grok adapter",
        });
      }
      if (profile.permission === "read-only" && profile.externalTools === "inherit") {
        context.addIssue({
          code: "custom",
          path: ["profiles", profileName, "externalTools"],
          message: "Read-only profiles cannot inherit external MCP tools",
        });
      }
      if (
        profile.adapter === "codex" &&
        profile.externalTools === "deny" &&
        profile.nativeProfile
      ) {
        context.addIssue({
          code: "custom",
          path: ["profiles", profileName, "nativeProfile"],
          message: "Codex nativeProfile requires externalTools: inherit",
        });
      }
    }
  });

export type AgentTeamConfig = z.infer<typeof configSchema>;
export type WorkflowRole = (typeof workflowRoles)[number];
export type AgentProfile = z.infer<typeof profileSchema>;
export type RolePolicy = z.infer<typeof roleSchema>;
export type NamedStrategy = z.infer<typeof namedStrategySchema>;
export type Reasoning = z.infer<typeof reasoningSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type ExternalToolsPolicy = z.infer<typeof externalToolsSchema>;
export type CommandSpec = z.infer<typeof commandSchema>;
export type ApprovalGate = z.infer<typeof approvalGateSchema>;
export type StrategyTopologyMode = z.infer<typeof strategyTopologyModeSchema>;
export type StrategyTopology = z.infer<typeof strategyTopologySchema>;
export type ObservabilityConfig = z.infer<typeof observabilitySchema>;
export type AutomaticEvolutionConfig = z.infer<typeof automaticEvolutionSchema>;
