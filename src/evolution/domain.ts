import { createHash } from "node:crypto";
import { z } from "zod";
import {
  approvalGateSchema,
  namedStrategySchema,
  strategyTopologyModeSchema,
  type NamedStrategy,
} from "../config/schema.js";
import { strategyBlueprintNameSchema } from "../strategies/catalog.js";

/** Phase-1 evolution domain document version. */
export const EVOLUTION_DOMAIN_VERSION = 1 as const;

export class EvolutionDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionDomainError";
  }
}

export class EvolutionValidationError extends EvolutionDomainError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionValidationError";
  }
}

export class EvolutionLifecycleError extends EvolutionDomainError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionLifecycleError";
  }
}

export class EvolutionPromotionError extends EvolutionDomainError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionPromotionError";
  }
}

const forbiddenPayloadKeys = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "credential",
  "credentials",
  "apiKey",
  "api_key",
  "authorization",
  "auth",
  "env",
  "environment",
  "processEnv",
  "process_env",
  "rawOutput",
  "raw_output",
  "stdout",
  "stderr",
  "commandOutput",
  "command_output",
]);

const prototypeMutationKeys = new Set(["__proto__"]);

const sourceCodeExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".rs",
  ".go",
  ".py",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
]);

const sourceCodePrefixes = ["src/", "web/", "scripts/", "src-tauri/", "test/", "schemas/"];

export const evolutionLifecycleStatuses = [
  "proposed",
  "evaluating",
  "evaluated",
  "promoted",
  "rejected",
  "rolled-back",
] as const;

export type EvolutionLifecycleStatus = (typeof evolutionLifecycleStatuses)[number];

/** Statuses that require attached evaluation evidence. */
const statusesRequiringEvaluation = new Set<EvolutionLifecycleStatus>([
  "evaluated",
  "promoted",
  "rejected",
  "rolled-back",
]);

/**
 * Non-sensitive transitions permitted by {@link transitionProposal}.
 * Promotion, rejection, and rollback require dedicated guarded operations.
 */
const genericLifecycleTransitions: ReadonlyArray<
  readonly [EvolutionLifecycleStatus, EvolutionLifecycleStatus]
> = [["proposed", "evaluating"]] as const;

/** Full phase-1 transition matrix (including guarded transitions). */
export const evolutionLifecycleTransitions: ReadonlyArray<
  readonly [EvolutionLifecycleStatus, EvolutionLifecycleStatus]
> = [
  ["proposed", "evaluating"],
  ["evaluating", "evaluated"],
  ["evaluated", "promoted"],
  ["evaluated", "rejected"],
  ["promoted", "rolled-back"],
] as const;

const allowedTransitionSet = new Set(
  evolutionLifecycleTransitions.map(([from, to]) => `${from}->${to}`),
);

const genericTransitionSet = new Set(
  genericLifecycleTransitions.map(([from, to]) => `${from}->${to}`),
);

export const evolutionCapabilitiesSchema = z
  .object({
    automaticExecution: z.literal(false),
    automaticPromotion: z.literal(false),
    networkPublication: z.literal(false),
    secretStorage: z.literal(false),
  })
  .strict();

const repositoryRelativeMarkdownPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    const reason = describeUnsafePath(value, { requireMarkdown: true });
    if (reason) {
      context.addIssue({ code: "custom", message: reason });
    }
  });

export const evolutionPolicySchema = z
  .object({
    version: z.literal(EVOLUTION_DOMAIN_VERSION),
    capabilities: evolutionCapabilitiesSchema,
    /**
     * Subset of configured role `promptFile` targets that may be proposed.
     * Paths are validated against a separately trusted project context at parse time.
     * Empty is valid for strategy-blueprint-only evolution (role promptFile is optional).
     */
    allowedPromptPaths: z.array(repositoryRelativeMarkdownPathSchema),
  })
  .strict()
  .superRefine((policy, context) => {
    const seen = new Set<string>();
    for (const [index, pathValue] of policy.allowedPromptPaths.entries()) {
      if (seen.has(pathValue)) {
        context.addIssue({
          code: "custom",
          path: ["allowedPromptPaths", index],
          message: `Duplicate allowed prompt path '${pathValue}'`,
        });
      }
      seen.add(pathValue);
    }
  });

export type EvolutionCapabilities = z.infer<typeof evolutionCapabilitiesSchema>;
export type EvolutionPolicy = z.infer<typeof evolutionPolicySchema>;

/**
 * Trusted project-derived mutation surface. Callers must build this from loaded
 * role configuration, not from untrusted policy input.
 */
export type EvolutionTrustContext = {
  /** Repository-relative Markdown paths from configured role `promptFile` values. */
  readonly configuredRolePromptPaths: readonly string[];
  /** Role name → allowed profile names from project configuration. */
  readonly roleAllowedProfiles: Readonly<Record<string, readonly string[]>>;
};

const contentDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Content digest must be a lowercase SHA-256 hex string");

const proposalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid proposal id");

const applicationCommandIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/**
 * Strategy definition for evolution candidates.
 * Mirrors {@link namedStrategySchema} behavioral rules; topology is strict so unknown
 * topology fields are rejected (namedStrategySchema uses a non-strict topology object).
 */
const evolutionStrategyTopologySchema = z
  .object({
    mode: strategyTopologyModeSchema,
  })
  .strict();

const evolutionStrategyDefinitionObjectSchema = z
  .object({
    topology: evolutionStrategyTopologySchema.default({ mode: "parallel-dag" }),
    maxParallel: z.number().int().min(1).max(32).optional(),
    maxReworkAttempts: z
      .number()
      .int()
      .min(0)
      .max(10)
      .refine((value) => !Object.is(value, -0), "Negative zero is not allowed")
      .optional(),
    executionTimeoutSeconds: z.number().int().min(60).max(604_800).optional(),
    maxAgentInvocations: z.number().int().min(1).max(1_000).optional(),
    maxProcessOutputBytes: z.number().int().min(4_096).max(16_777_216).optional(),
    maxArtifactBytes: z.number().int().min(1_048_576).max(10_737_418_240).optional(),
    roleProfiles: z.record(z.string().min(1), z.string().min(1)).default({}),
    approvalGates: z.array(approvalGateSchema).min(1).max(2).optional(),
    approvalTimeoutSeconds: z.number().int().min(60).max(604_800).optional(),
  })
  .strict();

const evolutionStrategyDefinitionSchema = evolutionStrategyDefinitionObjectSchema.superRefine(
  (strategy, context) => {
    // Keep behavioral parity with namedStrategySchema refinements.
    const named = namedStrategySchema.safeParse(strategy);
    if (!named.success) {
      for (const issue of named.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
  },
);

export const strategyBlueprintCandidateSchema = z
  .object({
    kind: z.literal("strategy-blueprint"),
    name: strategyBlueprintNameSchema,
    definition: evolutionStrategyDefinitionSchema,
  })
  .strict();

export const rolePromptCandidateSchema = z
  .object({
    kind: z.literal("role-prompt"),
    /** Repository-relative Markdown path; rejects absolute, traversal, and source targets. */
    path: repositoryRelativeMarkdownPathSchema,
    contentDigest: contentDigestSchema,
  })
  .strict();

export const evolutionCandidateSchema = z.discriminatedUnion("kind", [
  strategyBlueprintCandidateSchema,
  rolePromptCandidateSchema,
]);

export type StrategyBlueprintCandidate = z.infer<typeof strategyBlueprintCandidateSchema>;
export type RolePromptCandidate = z.infer<typeof rolePromptCandidateSchema>;
export type EvolutionCandidate = z.infer<typeof evolutionCandidateSchema>;

export const deterministicEvidenceSchema = z
  .object({
    kind: z.literal("deterministic"),
    id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid evidence id"),
    status: z.enum(["pass", "fail"]),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const advisoryEvidenceSchema = z
  .object({
    kind: z.literal("advisory"),
    id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid evidence id"),
    verdict: z.enum(["approve", "request_changes", "escalate"]),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const evolutionEvidenceItemSchema = z.discriminatedUnion("kind", [
  deterministicEvidenceSchema,
  advisoryEvidenceSchema,
]);

export const evolutionEvidenceSchema = z
  .object({
    /** Proposal this evidence evaluates; cannot be reused across proposals. */
    proposalId: proposalIdSchema,
    /** SHA-256 digest of the proposal candidate at evaluation time. */
    candidateDigest: contentDigestSchema,
    items: z.array(evolutionEvidenceItemSchema).min(1),
  })
  .strict()
  .superRefine((evidence, context) => {
    const ids = new Set<string>();
    for (const [index, item] of evidence.items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: `Duplicate evidence id '${item.id}'`,
        });
      }
      ids.add(item.id);
    }
  });

export type DeterministicEvidence = z.infer<typeof deterministicEvidenceSchema>;
export type AdvisoryEvidence = z.infer<typeof advisoryEvidenceSchema>;
export type EvolutionEvidenceItem = z.infer<typeof evolutionEvidenceItemSchema>;
export type EvolutionEvidence = z.infer<typeof evolutionEvidenceSchema>;

export const evaluationResultSchema = z
  .object({
    proposalId: proposalIdSchema,
    candidateDigest: contentDigestSchema,
    passed: z.boolean(),
    deterministicPassed: z.boolean(),
    advisoryPassed: z.boolean(),
    summary: z.string().trim().min(1).max(4_000),
    failedDeterministicIds: z.array(z.string().min(1)),
    advisoryVerdicts: z.array(z.enum(["approve", "request_changes", "escalate"])),
  })
  .strict()
  .superRefine((result, context) => {
    const deterministicPassed = result.failedDeterministicIds.length === 0;
    const advisoryPassed =
      deterministicPassed && result.advisoryVerdicts.every((verdict) => verdict === "approve");
    const passed = deterministicPassed && advisoryPassed;
    if (result.deterministicPassed !== deterministicPassed) {
      context.addIssue({
        code: "custom",
        path: ["deterministicPassed"],
        message: "deterministicPassed is inconsistent with failedDeterministicIds",
      });
    }
    if (result.advisoryPassed !== advisoryPassed) {
      context.addIssue({
        code: "custom",
        path: ["advisoryPassed"],
        message: "advisoryPassed is inconsistent with deterministic and advisory evidence",
      });
    }
    if (result.passed !== passed) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed is inconsistent with deterministicPassed and advisoryPassed",
      });
    }
  });

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

export const evolutionEvaluationSourceSchema = z.enum([
  "external",
  "server-structural-preflight-v1",
  "server-automatic-run-evaluation-v1",
]);

export type EvolutionEvaluationSource = z.infer<typeof evolutionEvaluationSourceSchema>;

export const proposalEvaluationSchema = z
  .object({
    source: evolutionEvaluationSourceSchema.default("external"),
    evidence: evolutionEvidenceSchema,
    result: evaluationResultSchema,
    at: z.string().datetime({ offset: true }),
  })
  .strict();

export type ProposalEvaluation = z.infer<typeof proposalEvaluationSchema>;

export const humanDecisionSchema = z
  .object({
    actor: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(2_000),
    decidedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type HumanDecision = z.infer<typeof humanDecisionSchema>;

export const promotionRecordSchema = z
  .object({
    kind: z.literal("promotion"),
    proposalId: proposalIdSchema,
    actor: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(2_000),
    at: z.string().datetime({ offset: true }),
    evaluation: evaluationResultSchema,
    /** Catalog-level pointer restored on rollback; domain does not apply file mutations. */
    previousActiveProposalId: proposalIdSchema.nullable(),
    /** Present only when the application coordinator owns this catalog mutation. */
    applicationCommandId: applicationCommandIdSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.evaluation.proposalId !== record.proposalId) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "proposalId"],
        message: "Promotion evaluation is bound to a different proposal",
      });
    }
    if (record.previousActiveProposalId === record.proposalId) {
      context.addIssue({
        code: "custom",
        path: ["previousActiveProposalId"],
        message: "A promotion cannot restore itself as the previous active proposal",
      });
    }
    if (!record.evaluation.passed) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "passed"],
        message: "Promotion records require a passing evaluation result",
      });
    }
    if (!record.evaluation.deterministicPassed || record.evaluation.failedDeterministicIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "deterministicPassed"],
        message: "Promotion records require deterministic evidence to have passed",
      });
    }
    if (record.evaluation.advisoryVerdicts.some((verdict) => verdict !== "approve")) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "advisoryVerdicts"],
        message: "Promotion records require fully approving advisory verdicts",
      });
    }
  });

export const rejectionRecordSchema = z
  .object({
    kind: z.literal("rejection"),
    proposalId: proposalIdSchema,
    actor: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(2_000),
    at: z.string().datetime({ offset: true }),
    evaluation: evaluationResultSchema.optional(),
  })
  .strict();

export const rollbackRecordSchema = z
  .object({
    kind: z.literal("rollback"),
    proposalId: proposalIdSchema,
    actor: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(2_000),
    at: z.string().datetime({ offset: true }),
    restoredActiveProposalId: proposalIdSchema.nullable(),
    /** Present only when the application coordinator owns this catalog mutation. */
    applicationCommandId: applicationCommandIdSchema.optional(),
  })
  .strict();

export const auditRecordSchema = z.discriminatedUnion("kind", [
  promotionRecordSchema,
  rejectionRecordSchema,
  rollbackRecordSchema,
]);

export type PromotionRecord = z.infer<typeof promotionRecordSchema>;
export type RejectionRecord = z.infer<typeof rejectionRecordSchema>;
export type RollbackRecord = z.infer<typeof rollbackRecordSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export const lifecycleTransitionSchema = z
  .object({
    from: z.enum(evolutionLifecycleStatuses),
    to: z.enum(evolutionLifecycleStatuses),
    at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((transition, context) => {
    if (!isAllowedLifecycleTransition(transition.from, transition.to)) {
      context.addIssue({
        code: "custom",
        message: `Illegal lifecycle transition '${transition.from}' -> '${transition.to}'`,
      });
    }
  });

export type LifecycleTransition = z.infer<typeof lifecycleTransitionSchema>;

const evolutionProposalObjectSchema = z
  .object({
    id: proposalIdSchema,
    createdAt: z.string().datetime({ offset: true }),
    status: z.enum(evolutionLifecycleStatuses),
    origin: z.literal("automatic-controller-v1").optional(),
    policy: evolutionPolicySchema,
    candidate: evolutionCandidateSchema,
    transitions: z.array(lifecycleTransitionSchema).default([]),
    evaluation: proposalEvaluationSchema.optional(),
    promotionRecordDigest: contentDigestSchema.optional(),
  })
  .strict();

export const evolutionProposalSchema = evolutionProposalObjectSchema.superRefine((proposal, context) => {
  refineProposalInvariants(proposal, context);
});

export type EvolutionProposal = z.infer<typeof evolutionProposalObjectSchema>;

/**
 * Build a trust context from project role configuration.
 * Does not read the filesystem; callers supply already-loaded role policies.
 */
export function createEvolutionTrustContext(input: {
  roles: Readonly<
    Record<string, { allowedProfiles: readonly string[]; promptFile?: string }>
  >;
}): EvolutionTrustContext {
  rejectForbiddenPayload(input, "trust");
  if (!input.roles || typeof input.roles !== "object" || Array.isArray(input.roles)) {
    throw new EvolutionValidationError("trust.roles: Role map is required");
  }

  const configuredRolePromptPaths: string[] = [];
  const roleAllowedProfiles = Object.create(null) as Record<string, readonly string[]>;
  const seenPaths = new Set<string>();

  for (const [roleName, role] of Object.entries(input.roles)) {
    if (!roleName.trim()) {
      throw new EvolutionValidationError("trust.roles: Role name must be non-empty");
    }
    if (!role || typeof role !== "object" || Array.isArray(role)) {
      throw new EvolutionValidationError(`trust.roles.${roleName}: Invalid role policy`);
    }
    if (!Array.isArray(role.allowedProfiles) || role.allowedProfiles.length === 0) {
      throw new EvolutionValidationError(
        `trust.roles.${roleName}.allowedProfiles: At least one allowed profile is required`,
      );
    }
    for (const profile of role.allowedProfiles) {
      if (typeof profile !== "string" || !profile.trim()) {
        throw new EvolutionValidationError(
          `trust.roles.${roleName}.allowedProfiles: Profile names must be non-empty strings`,
        );
      }
    }
    roleAllowedProfiles[roleName] = [...role.allowedProfiles];

    if (role.promptFile !== undefined) {
      if (typeof role.promptFile !== "string") {
        throw new EvolutionValidationError(
          `trust.roles.${roleName}.promptFile: Must be a repository-relative Markdown path`,
        );
      }
      const reason = describeUnsafePath(role.promptFile, { requireMarkdown: true });
      if (reason) {
        throw new EvolutionValidationError(`trust.roles.${roleName}.promptFile: ${reason}`);
      }
      if (!seenPaths.has(role.promptFile)) {
        seenPaths.add(role.promptFile);
        configuredRolePromptPaths.push(role.promptFile);
      }
    }
  }

  return deepFreeze({
    configuredRolePromptPaths,
    roleAllowedProfiles,
  });
}

export function parseEvolutionPolicy(
  input: unknown,
  trust: EvolutionTrustContext,
): EvolutionPolicy {
  rejectForbiddenPayload(input, "policy");
  assertTrustContext(trust);
  const parsed = evolutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw new EvolutionValidationError(formatIssues("policy", parsed.error.issues));
  }

  const configured = new Set(trust.configuredRolePromptPaths);
  for (const [index, pathValue] of parsed.data.allowedPromptPaths.entries()) {
    if (!configured.has(pathValue)) {
      throw new EvolutionValidationError(
        `policy.allowedPromptPaths.${index}: '${pathValue}' is not a configured role promptFile target`,
      );
    }
  }

  return deepFreeze(structuredClone(parsed.data));
}

export function parseEvolutionCandidate(
  input: unknown,
  policy: EvolutionPolicy,
  trust: EvolutionTrustContext,
): EvolutionCandidate {
  rejectForbiddenPayload(input, "candidate");
  assertTrustContext(trust);
  const parsed = evolutionCandidateSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvolutionValidationError(formatIssues("candidate", parsed.error.issues));
  }

  if (parsed.data.kind === "role-prompt") {
    const pathReason = describeUnsafePath(parsed.data.path, { requireMarkdown: true });
    if (pathReason) {
      throw new EvolutionValidationError(`candidate.path: ${pathReason}`);
    }
    if (!policy.allowedPromptPaths.includes(parsed.data.path)) {
      throw new EvolutionValidationError(
        `candidate.path: Prompt path '${parsed.data.path}' is not allowlisted by the evolution policy`,
      );
    }
    if (!trust.configuredRolePromptPaths.includes(parsed.data.path)) {
      throw new EvolutionValidationError(
        `candidate.path: Prompt path '${parsed.data.path}' is not a configured role promptFile target`,
      );
    }
  } else {
    validateStrategyRoleProfiles(parsed.data.definition.roleProfiles, trust);
  }

  return deepFreeze(structuredClone(parsed.data));
}

export function createEvolutionProposal(input: {
  id: string;
  createdAt: string;
  policy: unknown;
  candidate: unknown;
  trust: EvolutionTrustContext;
  origin?: "automatic-controller-v1";
}): EvolutionProposal {
  const policy = parseEvolutionPolicy(input.policy, input.trust);
  const candidate = parseEvolutionCandidate(input.candidate, policy, input.trust);
  const proposal = evolutionProposalSchema.parse({
    id: input.id,
    createdAt: input.createdAt,
    status: "proposed",
    ...(input.origin ? { origin: input.origin } : {}),
    policy,
    candidate,
    transitions: [],
  });
  return deepFreeze(structuredClone(proposal));
}

/**
 * Parse a persisted proposal document, rejecting corrupted lifecycle histories.
 *
 * The trusted project context is mandatory: durable state must never be accepted from
 * its self-declared policy allowlist alone. Use {@link evolutionProposalSchema} only for
 * explicitly shape-only validation that is not a trust decision.
 */
export function parseEvolutionProposal(
  input: unknown,
  trust: EvolutionTrustContext,
): EvolutionProposal {
  rejectForbiddenPayload(input, "proposal");
  assertTrustContext(trust);
  const parsed = evolutionProposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvolutionValidationError(formatIssues("proposal", parsed.error.issues));
  }

  const policy = parseEvolutionPolicy(parsed.data.policy, trust);
  parseEvolutionCandidate(parsed.data.candidate, policy, trust);

  return deepFreeze(structuredClone(parsed.data));
}

/**
 * Parse a persisted promotion audit record.
 * Requires a passing evaluation bound to the same proposal id.
 */
export function parsePromotionRecord(input: unknown): PromotionRecord {
  rejectForbiddenPayload(input, "promotion");
  const parsed = promotionRecordSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvolutionValidationError(formatIssues("promotion", parsed.error.issues));
  }
  return deepFreeze(structuredClone(parsed.data));
}

/**
 * Validate a promotion record against a proposal's recorded evaluation.
 * Used by durable catalog reopen to reject mismatched audit state.
 */
export function assertPromotionRecordMatchesProposal(
  record: PromotionRecord,
  proposal: EvolutionProposal,
): void {
  if (record.proposalId !== proposal.id) {
    throw new EvolutionValidationError(
      `promotion.proposalId: Record is bound to '${record.proposalId}', not '${proposal.id}'`,
    );
  }
  if (proposal.status !== "promoted" && proposal.status !== "rolled-back") {
    throw new EvolutionValidationError(
      `promotion: Proposal '${proposal.id}' is '${proposal.status}', not promoted or rolled-back`,
    );
  }
  if (!proposal.evaluation) {
    throw new EvolutionValidationError(
      `promotion: Proposal '${proposal.id}' is missing evaluation evidence required for promotion`,
    );
  }
  if (!deepEqual(record.evaluation, proposal.evaluation.result)) {
    throw new EvolutionValidationError(
      `promotion.evaluation: Does not match proposal '${proposal.id}' recorded evaluation result`,
    );
  }
  if (!record.evaluation.passed) {
    throw new EvolutionValidationError(
      `promotion.evaluation: Passing evaluation is required`,
    );
  }
  const promotionTransition = proposal.transitions.find(
    (transition) => transition.from === "evaluated" && transition.to === "promoted",
  );
  if (!promotionTransition || record.at !== promotionTransition.at) {
    throw new EvolutionValidationError(
      `promotion.at: Record timestamp does not match proposal '${proposal.id}' promotion transition`,
    );
  }
  if (
    !proposal.promotionRecordDigest ||
    computePromotionRecordDigest(record) !== proposal.promotionRecordDigest
  ) {
    throw new EvolutionValidationError(
      `promotion: Record does not match proposal '${proposal.id}' immutable promotion digest`,
    );
  }
}

export function parseEvolutionEvidence(input: unknown): EvolutionEvidence {
  rejectForbiddenPayload(input, "evidence");
  const parsed = evolutionEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvolutionValidationError(formatIssues("evidence", parsed.error.issues));
  }
  return deepFreeze(structuredClone(parsed.data));
}

export function parseHumanDecision(input: unknown): HumanDecision {
  rejectForbiddenPayload(input, "decision");
  const parsed = humanDecisionSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvolutionValidationError(formatIssues("decision", parsed.error.issues));
  }
  return deepFreeze(structuredClone(parsed.data));
}

export function isAllowedLifecycleTransition(
  from: EvolutionLifecycleStatus,
  to: EvolutionLifecycleStatus,
): boolean {
  return allowedTransitionSet.has(`${from}->${to}`);
}

export function assertLifecycleTransition(
  from: EvolutionLifecycleStatus,
  to: EvolutionLifecycleStatus,
): void {
  if (!isAllowedLifecycleTransition(from, to)) {
    throw new EvolutionLifecycleError(
      `Illegal lifecycle transition '${from}' -> '${to}'`,
    );
  }
}

/**
 * Append a non-sensitive lifecycle transition and return a new immutable proposal.
 * Promotion, rejection, and rollback must use their guarded operations.
 */
export function transitionProposal(
  proposal: EvolutionProposal,
  to: EvolutionLifecycleStatus,
  at: string,
): EvolutionProposal {
  if (!genericTransitionSet.has(`${proposal.status}->${to}`)) {
    if (isAllowedLifecycleTransition(proposal.status, to)) {
      throw new EvolutionLifecycleError(
        `Lifecycle transition '${proposal.status}' -> '${to}' requires a guarded operation ` +
          `(evaluateProposal, promoteProposal, rejectProposal, or rollbackProposal)`,
      );
    }
    assertLifecycleTransition(proposal.status, to);
  }

  const transition = lifecycleTransitionSchema.parse({
    from: proposal.status,
    to,
    at,
  });
  assertTransitionTimestamp(proposal, transition.at);

  const next: EvolutionProposal = {
    ...structuredClone(proposal),
    status: to,
    transitions: [...proposal.transitions, transition],
  };
  return deepFreeze(evolutionProposalSchema.parse(next));
}

/**
 * Record evaluation evidence and transition evaluating → evaluated.
 * Evidence is bound to the proposal id and candidate digest.
 */
export function evaluateProposal(
  proposal: EvolutionProposal,
  evidenceInput: unknown,
  at: string,
  source: EvolutionEvaluationSource = "external",
): EvolutionProposal {
  if (proposal.status !== "evaluating") {
    throw new EvolutionLifecycleError(
      `Proposal '${proposal.id}' must be in 'evaluating' status before evaluation (current: '${proposal.status}')`,
    );
  }

  const evidence = parseEvolutionEvidence(evidenceInput);
  assertEvidenceBoundToProposal(proposal, evidence);
  const result = computeEvaluationResult(evidence);
  assertTransitionTimestamp(proposal, at);

  const transition = lifecycleTransitionSchema.parse({
    from: "evaluating",
    to: "evaluated",
    at,
  });

  const next: EvolutionProposal = {
    ...structuredClone(proposal),
    status: "evaluated",
    transitions: [...proposal.transitions, transition],
    evaluation: {
      source,
      evidence: structuredClone(evidence),
      result: structuredClone(result),
      at,
    },
  };
  return deepFreeze(evolutionProposalSchema.parse(next));
}

/**
 * Compute evaluation result from evidence.
 * Any deterministic failure vetoes advisory verdicts.
 * Advisory-only approval cannot pass when deterministic checks fail or are absent.
 */
export function computeEvaluationResult(evidenceInput: unknown): EvaluationResult {
  const evidence = parseEvolutionEvidence(evidenceInput);
  const deterministic = evidence.items.filter(
    (item): item is DeterministicEvidence => item.kind === "deterministic",
  );
  const advisory = evidence.items.filter(
    (item): item is AdvisoryEvidence => item.kind === "advisory",
  );

  if (deterministic.length === 0) {
    throw new EvolutionValidationError(
      "evidence: At least one deterministic evidence item is required",
    );
  }

  const failedDeterministicIds = deterministic
    .filter((item) => item.status === "fail")
    .map((item) => item.id);
  const deterministicPassed = failedDeterministicIds.length === 0;
  const advisoryVerdicts = advisory.map((item) => item.verdict);
  const advisoryPassed =
    advisory.length === 0 || advisory.every((item) => item.verdict === "approve");

  // Deterministic failures always veto advisory approvals.
  const passed = deterministicPassed && advisoryPassed;
  const summary = passed
    ? "Evaluation passed: all deterministic checks passed and advisory verdicts approve or are absent"
    : deterministicPassed
      ? `Evaluation failed: advisory veto (${advisoryVerdicts.join(", ") || "none"})`
      : `Evaluation failed: deterministic veto for ${failedDeterministicIds.join(", ")}`;

  return deepFreeze(
    evaluationResultSchema.parse({
      proposalId: evidence.proposalId,
      candidateDigest: evidence.candidateDigest,
      passed,
      deterministicPassed,
      advisoryPassed: deterministicPassed ? advisoryPassed : false,
      summary,
      failedDeterministicIds,
      advisoryVerdicts,
    }),
  );
}

/**
 * Stable SHA-256 digest of a candidate. Used to bind evaluation evidence to a
 * specific immutable proposal candidate.
 */
export function computeCandidateDigest(candidate: EvolutionCandidate): string {
  return createHash("sha256").update(canonicalize(candidate)).digest("hex");
}

export function assertPromotionAllowed(input: {
  proposal: EvolutionProposal;
  evidence: unknown;
  decision: HumanDecision;
}): EvaluationResult {
  const { proposal, decision } = input;
  if (proposal.status !== "evaluated") {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' must be in 'evaluated' status before promotion (current: '${proposal.status}')`,
    );
  }
  if (!proposal.evaluation) {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' cannot be promoted: evaluation evidence is missing`,
    );
  }

  const evidence = parseEvolutionEvidence(input.evidence);
  assertEvidenceBoundToProposal(proposal, evidence);

  // Evidence supplied at promotion must match the evidence recorded at evaluation.
  if (!deepEqual(evidence, proposal.evaluation.evidence)) {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' cannot be promoted: evidence does not match the recorded evaluation snapshot`,
    );
  }

  const evaluation = computeEvaluationResult(evidence);
  if (!deepEqual(evaluation, proposal.evaluation.result)) {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' cannot be promoted: recomputed evaluation result is inconsistent`,
    );
  }

  if (!evaluation.passed) {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' cannot be promoted: evaluation did not pass`,
    );
  }
  if (!evaluation.deterministicPassed || evaluation.failedDeterministicIds.length > 0) {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' cannot be promoted: deterministic evidence failed`,
    );
  }
  if (evaluation.advisoryVerdicts.some((verdict) => verdict !== "approve")) {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' cannot be promoted: advisory evidence did not fully approve`,
    );
  }
  if (!decision.actor.trim() || !decision.reason.trim()) {
    throw new EvolutionPromotionError(
      `Proposal '${proposal.id}' cannot be promoted: human actor and reason are required`,
    );
  }

  return evaluation;
}

/**
 * Atomically promote an evaluated proposal: validates evidence, appends the
 * lifecycle transition, and creates the promotion audit record.
 */
export function promoteProposal(input: {
  proposal: EvolutionProposal;
  evidence: unknown;
  decision: unknown;
  previousActiveProposalId?: string | null;
  applicationCommandId?: string;
}): { proposal: EvolutionProposal; record: PromotionRecord } {
  const decision = parseHumanDecision(input.decision);
  const evaluation = assertPromotionAllowed({
    proposal: input.proposal,
    evidence: input.evidence,
    decision,
  });

  assertTransitionTimestamp(input.proposal, decision.decidedAt);
  const transition = lifecycleTransitionSchema.parse({
    from: "evaluated",
    to: "promoted",
    at: decision.decidedAt,
  });

  const record = deepFreeze(
    promotionRecordSchema.parse({
      kind: "promotion",
      proposalId: input.proposal.id,
      actor: decision.actor,
      reason: decision.reason,
      at: decision.decidedAt,
      evaluation: structuredClone(evaluation),
      previousActiveProposalId: input.previousActiveProposalId ?? null,
      ...(input.applicationCommandId === undefined
        ? {}
        : { applicationCommandId: input.applicationCommandId }),
    }),
  );

  const next: EvolutionProposal = {
    ...structuredClone(input.proposal),
    status: "promoted",
    transitions: [...input.proposal.transitions, transition],
    promotionRecordDigest: computePromotionRecordDigest(record),
  };
  const proposal = deepFreeze(evolutionProposalSchema.parse(next));
  assertPromotionRecordMatchesProposal(record, proposal);

  return { proposal, record };
}

/**
 * Atomically reject an evaluated proposal with a human decision and audit record.
 */
export function rejectProposal(input: {
  proposal: EvolutionProposal;
  decision: unknown;
}): { proposal: EvolutionProposal; record: RejectionRecord } {
  const decision = parseHumanDecision(input.decision);
  if (input.proposal.status !== "evaluated") {
    throw new EvolutionLifecycleError(
      `Proposal '${input.proposal.id}' must be in 'evaluated' status before rejection (current: '${input.proposal.status}')`,
    );
  }
  if (!input.proposal.evaluation) {
    throw new EvolutionLifecycleError(
      `Proposal '${input.proposal.id}' cannot be rejected: evaluation evidence is missing`,
    );
  }

  assertTransitionTimestamp(input.proposal, decision.decidedAt);
  const transition = lifecycleTransitionSchema.parse({
    from: "evaluated",
    to: "rejected",
    at: decision.decidedAt,
  });

  const next: EvolutionProposal = {
    ...structuredClone(input.proposal),
    status: "rejected",
    transitions: [...input.proposal.transitions, transition],
  };
  const proposal = deepFreeze(evolutionProposalSchema.parse(next));

  const record = deepFreeze(
    rejectionRecordSchema.parse({
      kind: "rejection",
      proposalId: proposal.id,
      actor: decision.actor,
      reason: decision.reason,
      at: decision.decidedAt,
      evaluation: structuredClone(proposal.evaluation!.result),
    }),
  );

  return { proposal, record };
}

/**
 * Atomically roll back a promoted proposal with a human decision and audit record.
 * Catalog-level only; does not modify strategy or prompt files.
 */
export function rollbackProposal(input: {
  proposal: EvolutionProposal;
  promotionRecord: unknown;
  decision: unknown;
  applicationCommandId?: string;
}): { proposal: EvolutionProposal; record: RollbackRecord } {
  const decision = parseHumanDecision(input.decision);
  if (input.proposal.status !== "promoted") {
    throw new EvolutionLifecycleError(
      `Proposal '${input.proposal.id}' must be in 'promoted' status before rollback (current: '${input.proposal.status}')`,
    );
  }
  const promotionRecord = parsePromotionRecord(input.promotionRecord);
  assertPromotionRecordMatchesProposal(promotionRecord, input.proposal);

  assertTransitionTimestamp(input.proposal, decision.decidedAt);
  const transition = lifecycleTransitionSchema.parse({
    from: "promoted",
    to: "rolled-back",
    at: decision.decidedAt,
  });

  const next: EvolutionProposal = {
    ...structuredClone(input.proposal),
    status: "rolled-back",
    transitions: [...input.proposal.transitions, transition],
  };
  const proposal = deepFreeze(evolutionProposalSchema.parse(next));

  const record = deepFreeze(
    rollbackRecordSchema.parse({
      kind: "rollback",
      proposalId: proposal.id,
      actor: decision.actor,
      reason: decision.reason,
      at: decision.decidedAt,
      restoredActiveProposalId: promotionRecord.previousActiveProposalId,
      ...(input.applicationCommandId === undefined
        ? {}
        : { applicationCommandId: input.applicationCommandId }),
    }),
  );

  return { proposal, record };
}

/** Validate a repository-relative role-prompt path without touching the filesystem. */
export function assertSafePromptPath(
  pathValue: string,
  allowedPromptPaths: readonly string[],
): string {
  const reason = describeUnsafePath(pathValue, { requireMarkdown: true });
  if (reason) {
    throw new EvolutionValidationError(reason);
  }
  if (!allowedPromptPaths.includes(pathValue)) {
    throw new EvolutionValidationError(
      `Prompt path '${pathValue}' is not allowlisted by the evolution policy`,
    );
  }
  return pathValue;
}

export function describeUnsafePath(
  pathValue: string,
  options: { requireMarkdown?: boolean } = {},
): string | undefined {
  if (!pathValue || pathValue.includes("\0")) {
    return "Path must be a non-empty repository-relative string without null bytes";
  }
  if (pathValue !== pathValue.trim()) {
    return "Path must not include leading or trailing whitespace";
  }
  if (isAbsolutePath(pathValue)) {
    return "Absolute paths are not allowed";
  }
  if (pathValue.includes("\\")) {
    return "Path must use POSIX separators only";
  }

  const segments = pathValue.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "Path contains an empty, current-directory, or parent-directory segment";
  }

  // Reject Windows drive-like and UNC-like forms that survived earlier checks.
  if (/^[A-Za-z]:/.test(pathValue) || pathValue.startsWith("//") || pathValue.startsWith("\\\\")) {
    return "Absolute paths are not allowed";
  }

  const normalized = segments.join("/");
  if (normalized !== pathValue) {
    return "Path is not in normalized repository-relative form";
  }

  const lower = normalized.toLowerCase();
  if (sourceCodePrefixes.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix))) {
    return "Source-code targets are not allowlisted mutation surfaces";
  }

  const lastSegment = segments[segments.length - 1]!;
  const dot = lastSegment.lastIndexOf(".");
  const extension = dot === -1 ? "" : lastSegment.slice(dot).toLowerCase();
  if (sourceCodeExtensions.has(extension)) {
    return "Source-code targets are not allowlisted mutation surfaces";
  }

  if (options.requireMarkdown && extension !== ".md") {
    return "Role prompt targets must be repository-relative Markdown paths";
  }

  return undefined;
}

function refineProposalInvariants(
  proposal: {
    id: string;
    createdAt: string;
    status: EvolutionLifecycleStatus;
    policy: EvolutionPolicy;
    candidate: EvolutionCandidate;
    transitions: LifecycleTransition[];
    evaluation?: ProposalEvaluation | undefined;
    promotionRecordDigest?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  // Candidate must satisfy the same path rules as parseEvolutionCandidate, relative to
  // the proposal's policy snapshot (trust-context checks happen at parse/create time).
  if (proposal.candidate.kind === "role-prompt") {
    const pathReason = describeUnsafePath(proposal.candidate.path, { requireMarkdown: true });
    if (pathReason) {
      context.addIssue({
        code: "custom",
        path: ["candidate", "path"],
        message: pathReason,
      });
    } else if (!proposal.policy.allowedPromptPaths.includes(proposal.candidate.path)) {
      context.addIssue({
        code: "custom",
        path: ["candidate", "path"],
        message: `Prompt path '${proposal.candidate.path}' is not allowlisted by the evolution policy`,
      });
    }
  }
  const createdAtMs = Date.parse(proposal.createdAt);
  if (Number.isNaN(createdAtMs)) {
    context.addIssue({
      code: "custom",
      path: ["createdAt"],
      message: "Invalid createdAt timestamp",
    });
    return;
  }

  if (proposal.status === "proposed") {
    if (proposal.transitions.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["transitions"],
        message: "A proposed proposal must not have lifecycle transitions",
      });
    }
  } else if (proposal.transitions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["transitions"],
      message: `Proposal status '${proposal.status}' requires a contiguous transition history starting from 'proposed'`,
    });
  } else {
    if (proposal.transitions[0]!.from !== "proposed") {
      context.addIssue({
        code: "custom",
        path: ["transitions", 0, "from"],
        message: "Transition history must begin from 'proposed'",
      });
    }

    let previousAt = createdAtMs;
    for (const [index, transition] of proposal.transitions.entries()) {
      const atMs = Date.parse(transition.at);
      if (Number.isNaN(atMs)) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "at"],
          message: "Invalid transition timestamp",
        });
        continue;
      }
      if (atMs < previousAt) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "at"],
          message: "Transition timestamps must be chronological and not precede creation",
        });
      }
      previousAt = atMs;

      if (index > 0) {
        const previous = proposal.transitions[index - 1]!;
        if (transition.from !== previous.to) {
          context.addIssue({
            code: "custom",
            path: ["transitions", index, "from"],
            message: `Transition history is discontinuous: expected from '${previous.to}', got '${transition.from}'`,
          });
        }
      }
    }

    const final = proposal.transitions[proposal.transitions.length - 1]!;
    if (final.to !== proposal.status) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Proposal status '${proposal.status}' does not match final transition '${final.from}' -> '${final.to}'`,
      });
    }
  }

  const needsEvaluation = statusesRequiringEvaluation.has(proposal.status);
  if (needsEvaluation && !proposal.evaluation) {
    context.addIssue({
      code: "custom",
      path: ["evaluation"],
      message: `Proposal status '${proposal.status}' requires evaluation evidence`,
    });
  }
  if (!needsEvaluation && proposal.evaluation) {
    context.addIssue({
      code: "custom",
      path: ["evaluation"],
      message: `Proposal status '${proposal.status}' must not include evaluation evidence`,
    });
  }

  const needsPromotionRecord = proposal.status === "promoted" || proposal.status === "rolled-back";
  if (needsPromotionRecord && !proposal.promotionRecordDigest) {
    context.addIssue({
      code: "custom",
      path: ["promotionRecordDigest"],
      message: `Proposal status '${proposal.status}' requires an immutable promotion record digest`,
    });
  }
  if (!needsPromotionRecord && proposal.promotionRecordDigest) {
    context.addIssue({
      code: "custom",
      path: ["promotionRecordDigest"],
      message: `Proposal status '${proposal.status}' must not include a promotion record digest`,
    });
  }

  if (proposal.evaluation) {
    const digest = computeCandidateDigest(proposal.candidate);
    if (proposal.evaluation.evidence.proposalId !== proposal.id) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "evidence", "proposalId"],
        message: "Evaluation evidence is bound to a different proposal",
      });
    }
    if (proposal.evaluation.evidence.candidateDigest !== digest) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "evidence", "candidateDigest"],
        message: "Evaluation evidence candidate digest does not match the proposal candidate",
      });
    }
    if (proposal.evaluation.result.proposalId !== proposal.id) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "result", "proposalId"],
        message: "Evaluation result is bound to a different proposal",
      });
    }
    if (proposal.evaluation.result.candidateDigest !== digest) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "result", "candidateDigest"],
        message: "Evaluation result candidate digest does not match the proposal candidate",
      });
    }

    try {
      const recomputed = computeEvaluationResult(proposal.evaluation.evidence);
      if (!deepEqual(recomputed, proposal.evaluation.result)) {
        context.addIssue({
          code: "custom",
          path: ["evaluation", "result"],
          message: "Evaluation result is inconsistent with the attached evidence",
        });
      }
      if (
        (proposal.status === "promoted" || proposal.status === "rolled-back") &&
        !recomputed.passed
      ) {
        context.addIssue({
          code: "custom",
          path: ["evaluation", "result", "passed"],
          message: `Proposal status '${proposal.status}' requires a passing evaluation`,
        });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "evidence"],
        message:
          error instanceof Error
            ? error.message
            : "Evaluation evidence is invalid",
      });
    }

    const evaluationAtMs = Date.parse(proposal.evaluation.at);
    if (!Number.isNaN(evaluationAtMs) && evaluationAtMs < createdAtMs) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "at"],
        message: "Evaluation timestamp must not precede proposal creation",
      });
    }

    const evaluateTransition = proposal.transitions.find(
      (transition) => transition.from === "evaluating" && transition.to === "evaluated",
    );
    if (!evaluateTransition) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "at"],
        message: "Evaluation requires an evaluating -> evaluated lifecycle transition",
      });
    } else if (proposal.evaluation.at !== evaluateTransition.at) {
      context.addIssue({
        code: "custom",
        path: ["evaluation", "at"],
        message: "Evaluation timestamp must match the evaluating -> evaluated transition",
      });
    }
  }
}

function assertEvidenceBoundToProposal(
  proposal: EvolutionProposal,
  evidence: EvolutionEvidence,
): void {
  if (evidence.proposalId !== proposal.id) {
    throw new EvolutionValidationError(
      `Evidence is bound to proposal '${evidence.proposalId}', not '${proposal.id}'`,
    );
  }
  const digest = computeCandidateDigest(proposal.candidate);
  if (evidence.candidateDigest !== digest) {
    throw new EvolutionValidationError(
      `Evidence candidate digest does not match proposal '${proposal.id}' candidate`,
    );
  }
}

function assertTransitionTimestamp(proposal: EvolutionProposal, at: string): void {
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) {
    throw new EvolutionValidationError(`Invalid transition timestamp '${at}'`);
  }
  const createdAtMs = Date.parse(proposal.createdAt);
  if (atMs < createdAtMs) {
    throw new EvolutionLifecycleError(
      `Transition timestamp '${at}' precedes proposal creation '${proposal.createdAt}'`,
    );
  }
  if (proposal.transitions.length > 0) {
    const previousAt = proposal.transitions[proposal.transitions.length - 1]!.at;
    if (atMs < Date.parse(previousAt)) {
      throw new EvolutionLifecycleError(
        `Transition timestamp '${at}' precedes previous transition '${previousAt}'`,
      );
    }
  }
}

function validateStrategyRoleProfiles(
  roleProfiles: Record<string, string>,
  trust: EvolutionTrustContext,
): void {
  for (const [roleName, profileName] of Object.entries(roleProfiles)) {
    if (!Object.hasOwn(trust.roleAllowedProfiles, roleName)) {
      throw new EvolutionValidationError(
        `candidate.definition.roleProfiles.${roleName}: Unknown role '${roleName}'`,
      );
    }
    const allowed = trust.roleAllowedProfiles[roleName];
    if (!Array.isArray(allowed)) {
      throw new EvolutionValidationError(
        `trust.roleAllowedProfiles.${roleName}: Allowed profiles must be an array`,
      );
    }
    if (!allowed.includes(profileName)) {
      throw new EvolutionValidationError(
        `candidate.definition.roleProfiles.${roleName}: Profile '${profileName}' is not allowed for role '${roleName}'`,
      );
    }
  }
}

function computePromotionRecordDigest(record: PromotionRecord): string {
  return createHash("sha256").update(canonicalize(record)).digest("hex");
}

function assertTrustContext(trust: EvolutionTrustContext): void {
  if (
    !trust ||
    !Array.isArray(trust.configuredRolePromptPaths) ||
    !trust.roleAllowedProfiles ||
    typeof trust.roleAllowedProfiles !== "object"
  ) {
    throw new EvolutionValidationError(
      "trust: A project-derived EvolutionTrustContext is required",
    );
  }
}

function isAbsolutePath(pathValue: string): boolean {
  if (pathValue.startsWith("/")) return true;
  if (pathValue.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(pathValue)) return true;
  if (pathValue.startsWith("\\\\") || pathValue.startsWith("//")) return true;
  return false;
}

function rejectForbiddenPayload(input: unknown, label: string): void {
  const prototypeHits = collectMatchingKeys(input, [], prototypeMutationKeys);
  if (prototypeHits.length > 0) {
    throw new EvolutionValidationError(
      `${label}: Prototype-mutating object keys are not allowed (${prototypeHits.join(", ")})`,
    );
  }

  const hits = collectForbiddenKeys(input, []);
  if (hits.length > 0) {
    throw new EvolutionValidationError(
      `${label}: Credential, environment, secret, or raw-output payloads are not allowed (${hits.join(", ")})`,
    );
  }
}

function collectMatchingKeys(
  value: unknown,
  pathSegments: string[],
  keys: ReadonlySet<string>,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectMatchingKeys(item, [...pathSegments, String(index)], keys),
    );
  }
  if (value && typeof value === "object") {
    const hits: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = [...pathSegments, key];
      if (keys.has(key)) {
        hits.push(nextPath.join("."));
      }
      hits.push(...collectMatchingKeys(child, nextPath, keys));
    }
    return hits;
  }
  return [];
}

function collectForbiddenKeys(value: unknown, pathSegments: string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectForbiddenKeys(item, [...pathSegments, String(index)]),
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const hits: string[] = [];
    for (const [key, child] of Object.entries(record)) {
      const nextPath = [...pathSegments, key];
      if (forbiddenPayloadKeys.has(key)) {
        hits.push(nextPath.join("."));
      }
      hits.push(...collectForbiddenKeys(child, nextPath));
    }
    return hits;
  }
  return [];
}

function formatIssues(label: string, issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : label;
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

// Re-export strategy types used by candidates for consumers.
export type { NamedStrategy };
