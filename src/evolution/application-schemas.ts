import { z } from "zod";
import { namedStrategySchema } from "../config/schema.js";
import { evolutionProposalSchema, humanDecisionSchema } from "./domain.js";
import { sha256Canonical, type ApplicationRecord } from "./application-shared.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nullableDigestSchema = sha256Schema.nullable();
const identifierSchema = z.string().min(1).max(512);
const commandIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const candidateTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role-prompt"), path: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("strategy-blueprint"), name: z.string().min(1).max(64) }).strict(),
]);
const promptTargetStateSchema = z
  .object({
    kind: z.literal("role-prompt"),
    identity: identifierSchema,
    digest: nullableDigestSchema,
    present: z.boolean(),
    mode: z.number().int().min(0).max(0o777).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.present !== (value.digest !== null)) {
      context.addIssue({ code: "custom", message: "prompt presence and digest disagree" });
    }
    if (value.present && value.mode === undefined) {
      context.addIssue({ code: "custom", message: "present prompt state requires mode" });
    }
  });
const strategyTargetStateSchema = z
  .object({
    kind: z.literal("strategy-blueprint"),
    identity: identifierSchema,
    digest: nullableDigestSchema,
    present: z.boolean(),
    strategyDefinition: namedStrategySchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.present !== (value.digest !== null) ||
      value.present !== (value.strategyDefinition !== null)
    ) {
      context.addIssue({ code: "custom", message: "strategy presence, digest, and definition disagree" });
    }
    if (value.strategyDefinition && sha256Canonical(value.strategyDefinition) !== value.digest) {
      context.addIssue({ code: "custom", message: "strategy definition digest mismatch" });
    }
  });
const targetDigestStateSchema = z.discriminatedUnion("kind", [
  promptTargetStateSchema,
  strategyTargetStateSchema,
]);
const applicationStatusSchema = z.enum([
  "applied",
  "rolled-back",
  "adopted",
  "aborted",
  "legacy-unreconciled",
]);
const applicationRecordSchema: z.ZodType<ApplicationRecord> = z.lazy(() =>
  z
    .object({
      proposalId: z.string().min(1).max(128),
      candidateDigest: sha256Schema,
      target: candidateTargetSchema,
      status: z.enum(["applied", "adopted"]),
      beforeTargetDigest: nullableDigestSchema,
      afterTargetDigest: sha256Schema,
      beforeTarget: targetDigestStateSchema,
      afterTarget: targetDigestStateSchema,
      previousApplication: applicationRecordSchema.nullable(),
      rollbackSafe: z.boolean(),
      catalogRevision: z.number().int().nonnegative().safe(),
      operator: z.string().min(1).max(256),
      reason: z.string().min(1).max(4_096),
      appliedAt: z.string().datetime({ offset: true }),
      commandId: commandIdSchema,
    })
    .strict(),
);
const completedApplicationRecordSchema = z
  .object({
    commandId: commandIdSchema,
    operation: z.enum(["promote-and-apply", "rollback-applied", "reconcile-promoted"]),
    proposalId: z.string().min(1).max(128),
    candidateDigest: sha256Schema,
    status: applicationStatusSchema,
    beforeTargetDigest: nullableDigestSchema,
    afterTargetDigest: nullableDigestSchema,
    catalogRevisionBefore: z.number().int().nonnegative().safe(),
    catalogRevisionAfter: z.number().int().nonnegative().safe(),
    operator: z.string().min(1).max(256),
    reason: z.string().min(1).max(4_096),
    completedAt: z.string().datetime({ offset: true }),
    humanDecision: humanDecisionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const validStatus =
      (value.operation === "promote-and-apply" &&
        ["applied", "aborted"].includes(value.status)) ||
      (value.operation === "rollback-applied" &&
        ["rolled-back", "aborted"].includes(value.status)) ||
      (value.operation === "reconcile-promoted" &&
        ["applied", "adopted", "aborted"].includes(value.status));
    if (!validStatus) {
      context.addIssue({ code: "custom", message: "completed operation status is invalid" });
    }
    const expectedRevisionAfter =
      value.operation === "reconcile-promoted" || value.status === "aborted"
        ? value.catalogRevisionBefore
        : value.catalogRevisionBefore + 1;
    if (value.catalogRevisionAfter !== expectedRevisionAfter) {
      context.addIssue({ code: "custom", message: "completed catalog revision is invalid" });
    }
    if (
      value.status === "aborted" &&
      value.beforeTargetDigest !== value.afterTargetDigest
    ) {
      context.addIssue({ code: "custom", message: "aborted target digest changed" });
    }
  });
const pendingApplicationOperationSchema = z
  .object({
    commandId: commandIdSchema,
    operation: z.enum(["promote-and-apply", "rollback-applied", "reconcile-promoted"]),
    proposalId: z.string().min(1).max(128),
    candidateDigest: sha256Schema,
    operator: z.string().min(1).max(256),
    reason: z.string().min(1).max(4_096),
    humanDecision: humanDecisionSchema,
    catalogRevisionBefore: z.number().int().nonnegative().safe(),
    expectedCatalogRevisionAfter: z.number().int().nonnegative().safe(),
    beforeTarget: targetDigestStateSchema,
    afterTarget: targetDigestStateSchema,
    previousActiveProposalId: z.string().min(1).max(128).nullable(),
    previousApplication: applicationRecordSchema.nullable(),
    previewTokenDigest: z.union([sha256Schema, z.string().regex(/^reconcile:(adopt|apply)$/)]),
    requestDigest: sha256Schema,
    materialDigest: sha256Schema.nullable(),
    expectedAuditDigest: sha256Schema.nullable(),
    gitBaseHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
    gitPath: z.string().min(1).max(512).nullable(),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const reconcileToken = value.previewTokenDigest.startsWith("reconcile:");
    if (
      (value.operation === "reconcile-promoted" &&
        value.previewTokenDigest !== "reconcile:apply") ||
      (value.operation !== "reconcile-promoted" && reconcileToken)
    ) {
      context.addIssue({ code: "custom", message: "pending operation mode is invalid" });
    }
    if (
      value.humanDecision.actor !== value.operator ||
      value.humanDecision.reason !== value.reason ||
      value.humanDecision.decidedAt !== value.startedAt
    ) {
      context.addIssue({ code: "custom", message: "pending human decision is invalid" });
    }
    if ((value.gitBaseHead === null) !== (value.gitPath === null)) {
      context.addIssue({ code: "custom", message: "Git recovery fields must appear together" });
    }
    if (value.operation === "reconcile-promoted" && value.expectedAuditDigest !== null) {
      context.addIssue({ code: "custom", message: "reconcile must not declare an audit digest" });
    }
    if (value.operation !== "reconcile-promoted" && value.expectedAuditDigest === null) {
      context.addIssue({ code: "custom", message: "catalog mutation requires an audit digest" });
    }
    if (
      (value.operation === "reconcile-promoted" &&
        value.expectedCatalogRevisionAfter !== value.catalogRevisionBefore) ||
      (value.operation !== "reconcile-promoted" &&
        value.expectedCatalogRevisionAfter !== value.catalogRevisionBefore + 1)
    ) {
      context.addIssue({ code: "custom", message: "expected catalog revision is invalid" });
    }
    if (
      value.beforeTarget.kind !== value.afterTarget.kind ||
      value.beforeTarget.identity !== value.afterTarget.identity
    ) {
      context.addIssue({ code: "custom", message: "pending target identity changed" });
    }
    const isPrompt = value.beforeTarget.kind === "role-prompt";
    if (isPrompt !== (value.gitBaseHead !== null)) {
      context.addIssue({ code: "custom", message: "prompt pending state requires Git proof" });
    }
    const expectedRequestDigest = sha256Canonical(
      value.operation === "reconcile-promoted"
        ? {
            operation: value.operation,
            proposalId: value.proposalId,
            expectedRevision: value.catalogRevisionBefore,
            operator: value.operator,
            reason: value.reason,
            mode: value.previewTokenDigest.slice("reconcile:".length),
            materialDigest: value.materialDigest,
          }
        : {
            operation: value.operation,
            proposalId: value.proposalId,
            expectedRevision: value.catalogRevisionBefore,
            tokenDigest: value.previewTokenDigest,
            operator: value.operator,
            reason: value.reason,
            materialDigest: value.materialDigest,
          },
    );
    if (expectedRequestDigest !== value.requestDigest) {
      context.addIssue({ code: "custom", message: "pending request digest mismatch" });
    }
    if (
      (value.operation !== "reconcile-promoted" && value.materialDigest !== null) ||
      (value.previewTokenDigest === "reconcile:adopt" && value.materialDigest !== null)
    ) {
      context.addIssue({ code: "custom", message: "pending material binding is invalid" });
    }
    const previousId = value.previousApplication?.proposalId ?? null;
    if (
      (value.operation === "promote-and-apply" &&
        (previousId !== value.previousActiveProposalId ||
          (value.previousActiveProposalId === null) !== (value.previousApplication === null))) ||
      (value.operation === "rollback-applied" &&
        (value.previousActiveProposalId !== value.proposalId || previousId !== value.proposalId)) ||
      (value.operation === "reconcile-promoted" &&
        value.previousActiveProposalId !== value.proposalId)
    ) {
      context.addIssue({ code: "custom", message: "pending predecessor proof mismatch" });
    }
  });
const applicationCommandResultPayloadSchema = z
  .object({
    proposal: evolutionProposalSchema,
    committedCatalogRevision: z.number().int().nonnegative().safe(),
    applicationStatus: applicationStatusSchema,
    beforeTargetDigest: nullableDigestSchema,
    afterTargetDigest: nullableDigestSchema,
  })
  .strict();
const commandIdempotencyBindingSchema = z
  .object({
    commandId: commandIdSchema,
    operation: z.enum(["promote-and-apply", "rollback-applied", "reconcile-promoted"]),
    proposalId: z.string().min(1).max(128),
    candidateDigest: sha256Schema,
    operator: z.string().min(1).max(256),
    reason: z.string().min(1).max(4_096),
    expectedRevision: z.number().int().nonnegative().safe(),
    previewTokenDigest: z.union([sha256Schema, z.string().regex(/^reconcile:(adopt|apply)$/)]),
    requestDigest: sha256Schema,
    materialDigest: sha256Schema.nullable(),
    result: applicationCommandResultPayloadSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const reconcileToken = value.previewTokenDigest.startsWith("reconcile:");
    const reconcileMode = reconcileToken
      ? value.previewTokenDigest.slice("reconcile:".length)
      : null;
    const validStatus =
      (value.operation === "promote-and-apply" &&
        ["applied", "aborted"].includes(value.result.applicationStatus)) ||
      (value.operation === "rollback-applied" &&
        ["rolled-back", "aborted"].includes(value.result.applicationStatus)) ||
      (reconcileMode === "adopt" && value.result.applicationStatus === "adopted") ||
      (reconcileMode === "apply" &&
        ["applied", "aborted"].includes(value.result.applicationStatus));
    if (
      (value.operation === "reconcile-promoted") !== reconcileToken ||
      !validStatus
    ) {
      context.addIssue({ code: "custom", message: "command operation mode/status is invalid" });
    }
    if (
      (value.operation !== "reconcile-promoted" && value.materialDigest !== null) ||
      (reconcileMode === "adopt" && value.materialDigest !== null)
    ) {
      context.addIssue({ code: "custom", message: "command material binding is invalid" });
    }
    const expectedResultRevision =
      value.operation === "reconcile-promoted" || value.result.applicationStatus === "aborted"
        ? value.expectedRevision
        : value.expectedRevision + 1;
    if (value.result.committedCatalogRevision !== expectedResultRevision) {
      context.addIssue({ code: "custom", message: "command result revision is invalid" });
    }
    if (
      value.result.applicationStatus === "aborted" &&
      value.result.beforeTargetDigest !== value.result.afterTargetDigest
    ) {
      context.addIssue({ code: "custom", message: "aborted command target digest changed" });
    }
    const expectedProposalStatus =
      value.result.applicationStatus === "rolled-back"
        ? "rolled-back"
        : value.result.applicationStatus === "aborted" &&
            value.operation === "promote-and-apply"
          ? "evaluated"
          : "promoted";
    if (value.result.proposal.status !== expectedProposalStatus) {
      context.addIssue({ code: "custom", message: "command result proposal status is invalid" });
    }
    const expected = sha256Canonical(
      value.operation === "reconcile-promoted"
        ? {
            operation: value.operation,
            proposalId: value.proposalId,
            expectedRevision: value.expectedRevision,
            operator: value.operator,
            reason: value.reason,
            mode: value.previewTokenDigest.slice("reconcile:".length),
            materialDigest: value.materialDigest,
          }
        : {
            operation: value.operation,
            proposalId: value.proposalId,
            expectedRevision: value.expectedRevision,
            tokenDigest: value.previewTokenDigest,
            operator: value.operator,
            reason: value.reason,
            materialDigest: value.materialDigest,
          },
    );
    if (expected !== value.requestDigest) {
      context.addIssue({ code: "custom", message: "command request digest mismatch" });
    }
  });
export const applicationPayloadSchema = z
  .object({
    applications: z.array(applicationRecordSchema).max(10_000),
    pending: pendingApplicationOperationSchema.nullable(),
    completed: z.array(completedApplicationRecordSchema).max(100_000),
    commands: z.array(commandIdempotencyBindingSchema).max(100_000),
    recoveryRequired: z.boolean(),
  })
  .strict();
