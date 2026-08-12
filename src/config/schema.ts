import { z } from "zod";

/** Roles that every project config must define. */
export const requiredWorkflowRoles = [
  "orchestrator",
  "architect",
  "worker",
  "reviewer",
  "tester",
] as const;

/**
 * Optional roles that projects may define.
 * - researcher（技术研究员）: read-only explore / technical research before planning.
 *   When absent from the yaml, loadConfig backfills it by mirroring architect's
 *   profile chain (built-in prompts/researcher.md); programmatic configs built
 *   without loadConfig still fall back to architect at the explore stage.
 */
export const optionalWorkflowRoles = ["researcher"] as const;

/** All known first-class workflow roles (required + optional). */
export const workflowRoles = [
  ...requiredWorkflowRoles,
  ...optionalWorkflowRoles,
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

/** Optional explore / plan / implement morphology (Kimi explore-plan-coder mapping). */
export const exploreMorphologySchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Optional profile override; must be read-only and allowed for architect when set. */
    profile: z.string().min(1).optional(),
    maxInjectedChars: z.number().int().min(0).max(50_000).default(4_000),
    failOpen: z.boolean().default(true),
  })
  .strict();

export const swarmMorphologySchema = z
  .object({
    /** Wave concurrency cap; effective value is min(this, maxParallel). */
    maxConcurrency: z.number().int().min(1).max(32).optional(),
  })
  .strict();

export const taskMorphologySchema = z
  .object({
    explore: exploreMorphologySchema.optional(),
    plan: z
      .object({
        role: z.literal("architect").default("architect"),
      })
      .strict()
      .optional(),
    implement: z
      .object({
        role: z.literal("worker").default("worker"),
        swarm: swarmMorphologySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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
    taskMorphology: taskMorphologySchema.optional(),
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
    const swarmCap = strategy.taskMorphology?.implement?.swarm?.maxConcurrency;
    if (
      swarmCap !== undefined &&
      strategy.maxParallel !== undefined &&
      swarmCap > strategy.maxParallel
    ) {
      context.addIssue({
        code: "custom",
        path: ["taskMorphology", "implement", "swarm", "maxConcurrency"],
        message: "swarm.maxConcurrency cannot exceed maxParallel",
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
    /**
     * When true, evaluation runs inherit the machine-global desktop CLI defaults
     * (~/.agent-team/desktop-settings.json) as roleBindings; strategy roleProfiles
     * in project yaml still win for roles they explicitly map.
     */
    useGlobalCliDefaults: z.boolean().default(false),
  })
  .strict()
  .superRefine((automation, context) => {
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
    useGlobalCliDefaults: false,
  }),
});

export const evaluationConfigSchema = z
  .object({
    /**
     * Inline authored suite document. Validated with EvaluationSuite schema at
     * load time to avoid a config↔evaluation import cycle.
     */
    suite: z.unknown().optional(),
    /** Path relative to the project root for a YAML/JSON suite file. */
    suiteFile: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (evaluation.suite && evaluation.suiteFile) {
      context.addIssue({
        code: "custom",
        path: ["suiteFile"],
        message: "Configure either evaluation.suite or evaluation.suiteFile, not both",
      });
    }
  });

export const experienceConfigSchema = z
  .object({
    /** Master switch for experience extract / retrieve / inject. */
    enabled: z.boolean().default(true),
    /** Inject verified experiences into orchestrator/architect planning context. */
    injectIntoPlanning: z.boolean().default(true),
    /** Inject verified failure experiences into worker rework attempts. */
    injectIntoRework: z.boolean().default(true),
    /** Extract candidate experiences when a run reaches a terminal status. */
    extractOnTerminal: z.boolean().default(true),
    /** Max verified experiences injected into a planning prompt. */
    maxInjected: z.number().int().min(0).max(32).default(8),
    /**
     * When true, promote requires suiteDigest or forceWithoutSuite.
     * Default false; enable when you want evaluation-gated promotion.
     */
    requireSuiteForPromote: z.boolean().default(false),
    /**
     * When a completed run can resolve an evaluation suite digest, auto-promote
     * extracted low-sensitivity success candidates with that digest.
     */
    autoPromoteWithSuite: z.boolean().default(true),
    /** Record attempt cards during rework for same-run / similar-failure memory. */
    recordAttemptCards: z.boolean().default(true),
    /** Write strategy hints when promoting success/rework experiences. */
    writeStrategyHints: z.boolean().default(true),
    /**
     * Optional override for the shared catalog directory (contains catalog.json).
     * Default: ~/.agent-team/experience/shared
     */
    sharedDirectory: z.string().min(1).optional(),
  })
  .strict();

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
    evaluation: evaluationConfigSchema.optional(),
    experience: experienceConfigSchema.default({
      enabled: true,
      injectIntoPlanning: true,
      injectIntoRework: true,
      extractOnTerminal: true,
      maxInjected: 8,
      requireSuiteForPromote: false,
      autoPromoteWithSuite: true,
      recordAttemptCards: true,
      writeStrategyHints: true,
    }),
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
        useGlobalCliDefaults: false,
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
    const automation = config.evolution.automatic;
    if (automation.enabled) {
      const hasGoal = Boolean(automation.evaluationGoal?.trim());
      const hasSuite = Boolean(config.evaluation?.suite || config.evaluation?.suiteFile);
      if (!hasGoal && !hasSuite) {
        context.addIssue({
          code: "custom",
          path: ["evolution", "automatic", "evaluationGoal"],
          message:
            "Enabled automatic evolution requires evaluationGoal or evaluation.suite / evaluation.suiteFile",
        });
      }
    }
    if (Object.keys(config.profiles).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["profiles"],
        message: "At least one profile is required",
      });
    }

    for (const roleName of requiredWorkflowRoles) {
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
        const exploreProfile = strategy.taskMorphology?.explore?.profile;
        if (exploreProfile) {
          const profile = config.profiles[exploreProfile];
          // Prefer researcher (技术研究员); allow architect allowlist for backward-compatible configs.
          const exploreOwners = [
            config.roles.researcher,
            config.roles.architect,
          ].filter(Boolean);
          const allowedByOwner = exploreOwners.some((role) =>
            role!.allowedProfiles.includes(exploreProfile),
          );
          if (!profile) {
            context.addIssue({
              code: "custom",
              path: ["strategies", "definitions", strategyName, "taskMorphology", "explore", "profile"],
              message: `Explore profile '${exploreProfile}' is not defined`,
            });
          } else if (profile.permission !== "read-only") {
            context.addIssue({
              code: "custom",
              path: ["strategies", "definitions", strategyName, "taskMorphology", "explore", "profile"],
              message: `Explore profile '${exploreProfile}' must be read-only`,
            });
          } else if (exploreOwners.length > 0 && !allowedByOwner) {
            context.addIssue({
              code: "custom",
              path: ["strategies", "definitions", strategyName, "taskMorphology", "explore", "profile"],
              message: `Explore profile '${exploreProfile}' is not allowed for researcher (or architect)`,
            });
          }
        }
      }
    }

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
export type EvaluationConfig = z.infer<typeof evaluationConfigSchema>;
