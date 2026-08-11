import { z } from "zod";
import { namedStrategySchema } from "../config/schema.js";
import { strategyBlueprintNameSchema } from "../strategies/catalog.js";

export const startRunRequestSchema = z.object({
  goal: z.string().trim().min(1).max(20_000),
  strategy: z.string().trim().min(1).optional(),
  profileOverrides: z.record(z.string().min(1), z.string().min(1)).default({}),
  parentRunId: z.string().min(1).optional(),
});

export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

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

export const cleanupPreviewRequestSchema = z.object({
  olderThanDays: z.number().int().min(1).max(3_650),
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

export const evolutionReasonRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(2_000) })
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

export type ApprovalResponseRequest = z.infer<typeof approvalResponseRequestSchema>;
export type ResumeRunRequest = z.infer<typeof resumeRunRequestSchema>;
export type CleanupPreviewRequest = z.infer<typeof cleanupPreviewRequestSchema>;
export type CleanupRunRequest = z.infer<typeof cleanupRunRequestSchema>;
