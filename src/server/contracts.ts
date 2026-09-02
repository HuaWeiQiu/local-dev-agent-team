import { z } from "zod";
import { namedStrategySchema } from "../config/schema.js";
import { strategyBlueprintNameSchema } from "../strategies/catalog.js";

export const roleBindingSchema = z.object({
  cli: z.enum(["codex", "grok", "kimi", "claude"]),
  model: z.string().trim().min(1).max(200).optional(),
  reasoning: z.string().trim().min(1).max(64).optional(),
});

export const startRunRequestSchema = z.object({
  goal: z.string().trim().min(1).max(20_000),
  strategy: z.string().trim().min(1).optional(),
  profileOverrides: z.record(z.string().min(1), z.string().min(1)).default({}),
  /** Global CLI picker: per-role CLI / model / reasoning for this run. */
  roleBindings: z.record(z.string().min(1), roleBindingSchema).optional(),
  parentRunId: z.string().min(1).optional(),
  /** PR target / run base branch. Defaults to project.defaultBranch. */
  baseBranch: z.string().trim().min(1).max(200).optional(),
  /** Custom PR head branch name; the runner creates it from baseCommit. */
  headBranchName: z.string().trim().min(1).max(240).optional(),
  /** ff-only sync the remote default branch before resolving the base commit. */
  syncDefaultFirst: z.boolean().optional(),
  stashIfDirty: z.boolean().optional(),
});

export type StartRunRequest = z.infer<typeof startRunRequestSchema>;
export type RoleBindingRequest = z.infer<typeof roleBindingSchema>;

export const branchCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(240),
  baseBranch: z.string().trim().min(1).max(200).optional(),
  syncFirst: z.boolean().optional(),
});

export const branchSyncRequestSchema = z.object({
  branch: z.string().trim().min(1).max(200).optional(),
});

export const gitConnectRequestSchema = z.object({
  action: z.enum(["login", "refresh", "cancel"]).optional(),
});

export const gitCommitRequestSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  paths: z.array(z.string().trim().min(1).max(500)).min(1).max(200),
});

export type GitConnectRequest = z.infer<typeof gitConnectRequestSchema>;
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;

export type BranchCreateRequest = z.infer<typeof branchCreateRequestSchema>;
export type BranchSyncRequest = z.infer<typeof branchSyncRequestSchema>;

export const publishRunRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
  pushBaseBranch: z.boolean().optional(),
  draft: z.boolean().optional(),
});

export type PublishRunRequest = z.infer<typeof publishRunRequestSchema>;

export const inquiryRequestSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  stage: z.string().trim().min(1).max(40).optional(),
});

export type InquiryRequest = z.infer<typeof inquiryRequestSchema>;

export const desktopSettingsUpdateSchema = z.object({
  defaults: z.object({
    roles: z.record(z.string().min(1), roleBindingSchema).default({}),
  }).default({ roles: {} }),
  ui: z.object({
    showCliPickerInRunLauncher: z.boolean().default(true),
    autoDetectCliConfig: z.boolean().default(true),
    autoDetectOnFocus: z.boolean().default(true),
  }).default({
    showCliPickerInRunLauncher: true,
    autoDetectCliConfig: true,
    autoDetectOnFocus: true,
  }),
});

/** Per-project role overrides. Omit a role (or set null) to inherit the global default. */
export const projectRoleSettingsUpdateSchema = z.object({
  roles: z.record(z.string().min(1), roleBindingSchema.nullable()).default({}),
});

export const strategyBlueprintRequestSchema = z.object({
  definition: namedStrategySchema,
});

export const strategyBlueprintPreflightRequestSchema = z.object({
  name: strategyBlueprintNameSchema,
  definition: namedStrategySchema,
});

export const approvalResponseRequestSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
});

export const resumeRunRequestSchema = z.object({
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
});

export const pauseRunRequestSchema = z.object({
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
});

export const cleanupPreviewRequestSchema = z.object({
  /** 0 = all eligible terminal runs regardless of age. */
  olderThanDays: z.number().int().min(0).max(3_650),
});

export const cleanupRunRequestSchema = z.object({
  token: z.string().uuid(),
});

export const evolutionStrategyProposalRequestSchema = z
  .object({
    name: strategyBlueprintNameSchema,
    definition: namedStrategySchema,
  })
  .strict();

export const evolutionPromptProposalRequestSchema = z
  .object({
    role: z.string().trim().min(1).max(128),
    encoding: z.literal("base64"),
    content: z.string().max(349_528),
  })
  .strict();

export const evolutionEmptyRequestSchema = z.object({}).strict();

export const evolutionAutomationStartRequestSchema = z
  .object({ maxCycles: z.number().int().min(1).max(10).optional() })
  .strict();

export const evolutionReasonRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(2_000) })
  .strict();

export const evolutionArchiveRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const evolutionDeleteRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const evolutionPreviewRequestSchema = z
  .object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
  .strict();

export const evolutionConfirmRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    token: z.string().min(1).max(256),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const evolutionReconcileRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const experienceReasonRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000),
    actor: z.string().trim().min(1).max(200).optional(),
    /** SHA-256 of evaluation suite that validated this experience. */
    suiteDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "suiteDigest must be a 64-char hex SHA-256")
      .optional(),
    /** Bypass suite requirement when experience.requireSuiteForPromote is true. */
    forceWithoutSuite: z.boolean().optional(),
  })
  .strict();

export type ApprovalResponseRequest = z.infer<typeof approvalResponseRequestSchema>;
export type ResumeRunRequest = z.infer<typeof resumeRunRequestSchema>;
export type PauseRunRequest = z.infer<typeof pauseRunRequestSchema>;
export type CleanupPreviewRequest = z.infer<typeof cleanupPreviewRequestSchema>;
export type CleanupRunRequest = z.infer<typeof cleanupRunRequestSchema>;
