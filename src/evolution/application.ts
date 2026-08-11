import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open as openAsync,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { clearPromptTemplateCache } from "../agents/service.js";
import type { LoadedConfig } from "../config/load.js";
import { namedStrategySchema, type NamedStrategy } from "../config/schema.js";
import {
  GitManager,
  GitManagerError,
  type ExactTrackedFileCommitAuthorization,
} from "../git/manager.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintConflictError,
  StrategyBlueprintDriftError,
  StrategyBlueprintError,
  StrategyBlueprintIndeterminateError,
  type StrategyBlueprintExpectedBefore,
} from "../strategies/catalog.js";
import {
  EvolutionCatalogConflictError,
  EvolutionCatalogNotFoundError,
  type EvolutionCandidateTarget,
  type EvolutionCatalogSnapshot,
} from "./catalog.js";
import {
  computeCandidateDigest,
  EvolutionDomainError,
  EvolutionLifecycleError,
  EvolutionPromotionError,
  EvolutionValidationError,
  evolutionProposalSchema,
  humanDecisionSchema,
  parseHumanDecision,
  type EvolutionCandidate,
  type EvolutionProposal,
  type HumanDecision,
  type PromotionRecord,
  type RejectionRecord,
  type RollbackRecord,
} from "./domain.js";
import {
  computePayloadDigest,
  DurableEvolutionCatalog,
  EvolutionPersistenceError,
  EvolutionPersistenceValidationError,
  type DurableEvolutionFileIo,
} from "./persistence.js";

/** Application-state document version under `<stateDirectory>/evolution/`. */
export const EVOLUTION_APPLICATION_DOCUMENT_VERSION = 1 as const;

/** Primary application-state filename. */
export const EVOLUTION_APPLICATION_FILENAME = "application-state.json" as const;

/** Maximum UTF-8 byte length accepted for role-prompt material (256 KiB). */
export const EVOLUTION_PROMPT_MATERIAL_MAX_BYTES = 256 * 1024;

/** Default preview token lifetime. */
export const EVOLUTION_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_APPLICATION_HISTORY_DEPTH = 100;

export const evolutionApplicationErrorCodes = [
  "PROPOSAL_NOT_FOUND",
  "INVALID_LIFECYCLE",
  "EVALUATION_NOT_PASSED",
  "EVALUATION_SOURCE_UNTRUSTED",
  "STALE_CATALOG_REVISION",
  "STALE_PREVIEW",
  "ACTIVE_TARGET_CONFLICT",
  "ACTIVE_RUN_CONFLICT",
  "TARGET_DRIFTED",
  "MATERIAL_MISSING",
  "RECOVERY_REQUIRED",
  "POLICY_DENIED",
  "COMMAND_CONFLICT",
] as const;

export type EvolutionApplicationErrorCode = (typeof evolutionApplicationErrorCodes)[number];

export class EvolutionApplicationError extends EvolutionDomainError {
  readonly code: EvolutionApplicationErrorCode;

  constructor(code: EvolutionApplicationErrorCode, message: string) {
    super(message);
    this.name = "EvolutionApplicationError";
    this.code = code;
  }
}

export type ApplicationCommandKind =
  | "promote-and-apply"
  | "rollback-applied"
  | "reconcile-promoted";

export type ApplicationStatus =
  | "applied"
  | "rolled-back"
  | "adopted"
  | "aborted"
  | "legacy-unreconciled";

export type TargetDigestState = {
  readonly kind: EvolutionCandidate["kind"];
  readonly identity: string;
  readonly digest: string | null;
  readonly present: boolean;
  readonly strategyDefinition?: NamedStrategy | null;
  /** Existing prompt file permission bits; never includes file-type or special bits. */
  readonly mode?: number | undefined;
};

export type ApplicationRecord = {
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly target: EvolutionCandidateTarget;
  readonly status: "applied" | "adopted";
  readonly beforeTargetDigest: string | null;
  readonly afterTargetDigest: string;
  readonly beforeTarget: TargetDigestState;
  readonly afterTarget: TargetDigestState;
  readonly previousApplication: ApplicationRecord | null;
  readonly rollbackSafe: boolean;
  readonly catalogRevision: number;
  readonly operator: string;
  readonly reason: string;
  readonly appliedAt: string;
  readonly commandId: string;
};

export type CompletedApplicationRecord = {
  readonly commandId: string;
  readonly operation: ApplicationCommandKind;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly status: ApplicationStatus;
  readonly beforeTargetDigest: string | null;
  readonly afterTargetDigest: string | null;
  readonly catalogRevisionBefore: number;
  readonly catalogRevisionAfter: number;
  readonly operator: string;
  readonly reason: string;
  readonly completedAt: string;
  readonly humanDecision: HumanDecision;
};

export type PendingApplicationOperation = {
  readonly commandId: string;
  readonly operation: ApplicationCommandKind;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly operator: string;
  readonly reason: string;
  readonly humanDecision: HumanDecision;
  readonly catalogRevisionBefore: number;
  readonly expectedCatalogRevisionAfter: number;
  readonly beforeTarget: TargetDigestState;
  readonly afterTarget: TargetDigestState;
  readonly previousActiveProposalId: string | null;
  readonly previousApplication: ApplicationRecord | null;
  readonly previewTokenDigest: string;
  readonly requestDigest: string;
  readonly materialDigest: string | null;
  readonly expectedAuditDigest: string | null;
  readonly gitBaseHead: string | null;
  readonly gitPath: string | null;
  readonly startedAt: string;
};

export type CommandIdempotencyBinding = {
  readonly commandId: string;
  readonly operation: ApplicationCommandKind;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly operator: string;
  readonly reason: string;
  readonly expectedRevision: number;
  readonly previewTokenDigest: string;
  readonly requestDigest: string;
  readonly materialDigest: string | null;
  readonly result: ApplicationCommandResultPayload;
};

export type ApplicationCommandResultPayload = {
  readonly proposal: EvolutionProposal;
  readonly committedCatalogRevision: number;
  readonly applicationStatus: ApplicationStatus;
  readonly beforeTargetDigest: string | null;
  readonly afterTargetDigest: string | null;
};

export type ApplicationCommandResult = {
  readonly proposal: EvolutionProposal;
  readonly committedCatalogRevision: number;
  readonly applicationStatus: ApplicationStatus;
  readonly beforeTargetDigest: string | null;
  readonly afterTargetDigest: string | null;
  readonly deduplicated: boolean;
};

export type ApplicationPreview = {
  readonly token: string;
  readonly kind: ApplicationCommandKind;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly catalogRevision: number;
  readonly activeProposalId: string | null;
  readonly currentTargetDigest: string | null;
  readonly operator: string;
  readonly expiresAt: string;
  readonly beforeTarget: Omit<TargetDigestState, "strategyDefinition">;
  readonly afterTarget: Omit<TargetDigestState, "strategyDefinition">;
};

export type ApplicationPreviewMaterial =
  | {
      readonly kind: "role-prompt";
      readonly identity: string;
      readonly digest: string | null;
      readonly present: boolean;
      readonly content: string | null;
    }
  | {
      readonly kind: "strategy-blueprint";
      readonly identity: string;
      readonly digest: string | null;
      readonly present: boolean;
      readonly definition: NamedStrategy | null;
    };

export type ApplicationPreviewDescription = {
  readonly kind: "promote-and-apply" | "rollback-applied";
  readonly proposalId: string;
  readonly before: ApplicationPreviewMaterial;
  readonly after: ApplicationPreviewMaterial;
};

export type ApplicationStateSnapshot = {
  readonly revision: number;
  readonly applications: readonly ApplicationRecord[];
  readonly pending: PendingApplicationOperation | null;
  readonly completed: readonly CompletedApplicationRecord[];
  readonly recoveryRequired: boolean;
};

type ApplicationPayload = {
  readonly applications: readonly ApplicationRecord[];
  readonly pending: PendingApplicationOperation | null;
  readonly completed: readonly CompletedApplicationRecord[];
  readonly commands: readonly CommandIdempotencyBinding[];
  readonly recoveryRequired: boolean;
};

type ApplicationDocument = {
  readonly version: typeof EVOLUTION_APPLICATION_DOCUMENT_VERSION;
  readonly revision: number;
  readonly payloadDigest: string;
  readonly payload: ApplicationPayload;
};

type PreviewRecord = {
  readonly token: string;
  readonly tokenDigest: string;
  readonly kind: ApplicationCommandKind;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly catalogRevision: number;
  readonly activeProposalId: string | null;
  readonly currentTargetDigest: string | null;
  readonly operator: string;
  readonly expiresAt: string;
  readonly beforeTarget: TargetDigestState;
  readonly afterTarget: TargetDigestState;
  readonly previousApplication: ApplicationRecord | null;
  readonly previousActiveProposalId: string | null;
  readonly expectedCatalogRevisionAfter: number;
};

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
const applicationPayloadSchema = z
  .object({
    applications: z.array(applicationRecordSchema).max(10_000),
    pending: pendingApplicationOperationSchema.nullable(),
    completed: z.array(completedApplicationRecordSchema).max(100_000),
    commands: z.array(commandIdempotencyBindingSchema).max(100_000),
    recoveryRequired: z.boolean(),
  })
  .strict();

export type EvolutionApplicationFileIo = DurableEvolutionFileIo & {
  writeFile: typeof writeFile;
  chmod: typeof chmod;
};

export type EvolutionApplicationCoordinatorOptions = {
  catalog: DurableEvolutionCatalog;
  strategies: StrategyBlueprintCatalog;
  git: GitManager;
  loaded: LoadedConfig;
  /** Fail closed when any workflow/run is active for the project. */
  assertQuiescent: () => void | Promise<void>;
  io?: Partial<EvolutionApplicationFileIo>;
  now?: () => number;
  previewTtlMs?: number;
};

const defaultFileIo: EvolutionApplicationFileIo = {
  mkdir,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  open: openAsync,
  syncDirectory: defaultSyncDirectory,
  writeFile,
  chmod,
};

/**
 * Exclusive Phase-3 facade that coordinates durable catalog promotion/rollback
 * with repository-local target application for role prompts and custom strategy
 * blueprints. Apply/rollback never accept prompt bytes or caller-selected paths.
 */
export class EvolutionApplicationCoordinator {
  readonly evolutionDirectory: string;
  readonly applicationFilePath: string;
  readonly objectsDirectory: string;

  readonly #catalog: DurableEvolutionCatalog;
  readonly #strategies: StrategyBlueprintCatalog;
  readonly #git: GitManager;
  readonly #loaded: LoadedConfig;
  #catalogWriter: object | undefined;
  #io: EvolutionApplicationFileIo;
  #assertQuiescent: () => void | Promise<void>;
  #now: () => number;
  #previewTtlMs: number;
  #queue: Promise<void> = Promise.resolve();
  #revision = 0;
  #applications = new Map<string, ApplicationRecord>();
  #pending: PendingApplicationOperation | null = null;
  #completed: CompletedApplicationRecord[] = [];
  #commands = new Map<string, CommandIdempotencyBinding>();
  #previews = new Map<string, PreviewRecord>();
  #recoveryRequired = false;
  #opened = false;
  #persistedContents: string | null = null;
  #publishedState: ApplicationStateSnapshot = Object.freeze({
    revision: 0,
    applications: Object.freeze([]),
    pending: null,
    completed: Object.freeze([]),
    recoveryRequired: false,
  });

  private constructor(options: {
    catalog: DurableEvolutionCatalog;
    strategies: StrategyBlueprintCatalog;
    git: GitManager;
    loaded: LoadedConfig;
    evolutionDirectory: string;
    applicationFilePath: string;
    objectsDirectory: string;
    io: EvolutionApplicationFileIo;
    assertQuiescent: () => void | Promise<void>;
    now: () => number;
    previewTtlMs: number;
  }) {
    this.#catalog = options.catalog;
    this.#strategies = options.strategies;
    this.#git = options.git;
    this.#loaded = options.loaded;
    this.evolutionDirectory = options.evolutionDirectory;
    this.applicationFilePath = options.applicationFilePath;
    this.objectsDirectory = options.objectsDirectory;
    this.#io = options.io;
    this.#assertQuiescent = options.assertQuiescent;
    this.#now = options.now;
    this.#previewTtlMs = options.previewTtlMs;
  }

  static async open(
    options: EvolutionApplicationCoordinatorOptions,
  ): Promise<EvolutionApplicationCoordinator> {
    if (!options.catalog || !options.strategies || !options.git || !options.loaded) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        "EvolutionApplicationCoordinator requires catalog, strategies, git, and loaded config",
      );
    }
    if (typeof options.assertQuiescent !== "function") {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        "EvolutionApplicationCoordinator requires an injected assertQuiescent callback",
      );
    }

    const io: EvolutionApplicationFileIo = { ...defaultFileIo, ...options.io };
    const [loadedRoot, gitRoot] = await Promise.all([
      io.realpath(path.resolve(options.loaded.root)),
      io.realpath(path.resolve(options.git.root)),
    ]);
    if (
      options.catalog.root !== options.strategies.root ||
      options.catalog.root !== loadedRoot ||
      options.catalog.root !== gitRoot ||
      options.catalog.stateDirectory !== options.strategies.stateDirectory
    ) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        "Catalog, strategy catalog, Git manager, and loaded config must share one canonical repository and state directory",
      );
    }
    const evolutionDirectory = options.catalog.evolutionDirectory;
    const applicationFilePath = path.join(evolutionDirectory, EVOLUTION_APPLICATION_FILENAME);
    const objectsDirectory = path.join(evolutionDirectory, "objects", "sha256");

    await createDirectoryChain(io, options.catalog.root, evolutionDirectory, 0o700);
    await createDirectoryChain(io, options.catalog.root, objectsDirectory, 0o700);
    await assertSafeRegularFileOrMissing(io, options.catalog.root, applicationFilePath);
    await cleanOrphanTemps(io, evolutionDirectory, EVOLUTION_APPLICATION_FILENAME);

    const coordinator = new EvolutionApplicationCoordinator({
      catalog: options.catalog,
      strategies: options.strategies,
      git: options.git,
      loaded: options.loaded,
      evolutionDirectory,
      applicationFilePath,
      objectsDirectory,
      io,
      assertQuiescent: options.assertQuiescent,
      now: options.now ?? Date.now,
      previewTtlMs: options.previewTtlMs ?? EVOLUTION_PREVIEW_TTL_MS,
    });
    await coordinator.#loadOrInit();
    coordinator.#catalogWriter = options.catalog.claimExclusiveWriter();
    try {
      await coordinator.#reconcilePendingOnOpen();
      coordinator.#publishCommittedState();
      coordinator.#opened = true;
      return coordinator;
    } catch (error) {
      options.catalog.releaseExclusiveWriter(coordinator.#catalogWriter);
      coordinator.#catalogWriter = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    return await this.#enqueue(async () => {
      this.#previews.clear();
      this.#opened = false;
      if (this.#catalogWriter) {
        this.#catalog.releaseExclusiveWriter(this.#catalogWriter);
        this.#catalogWriter = undefined;
      }
    });
  }

  /** Read a proposal from the durable catalog (no mutation). */
  readProposal(proposalId: string): EvolutionProposal | undefined {
    this.#assertOpen();
    return this.#catalog.getProposal(proposalId);
  }

  /** Return the durable application record for a proposal, if any. */
  getApplication(proposalId: string): ApplicationRecord | undefined {
    this.#assertOpen();
    const application = this.#publishedState.applications.find(
      (record) => record.proposalId === proposalId,
    );
    return application === undefined ? undefined : isolate(application);
  }

  /** Snapshot application-state (not catalog). */
  getApplicationState(): ApplicationStateSnapshot {
    this.#assertOpen();
    return isolate(this.#publishedState);
  }

  /** Queue-consistent aggregate for future HTTP/SSE projections. */
  async readControlSnapshot(): Promise<{
    catalogRevision: number;
    catalog: EvolutionCatalogSnapshot;
    application: ApplicationStateSnapshot;
  }> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const { revision, snapshot } = await this.#catalog.readSnapshot();
      return isolate({
        catalogRevision: revision,
        catalog: snapshot,
        application: this.#publishedState,
      });
    });
  }

  /**
   * Propose a candidate. Role-prompt proposals must supply UTF-8 content bytes
   * that match `candidate.contentDigest`; material is stored immutably under
   * `evolution/objects/sha256/<digest>`. Apply/rollback never accept content.
   */
  async propose(input: {
    id: string;
    policy: unknown;
    candidate: unknown;
    promptContent?: Uint8Array;
  }): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      const proposalInput = {
        id: input.id,
        createdAt: new Date(this.#now()).toISOString(),
        policy: input.policy,
        candidate: input.candidate,
      };
      let validated: EvolutionProposal;
      try {
        validated = await this.#catalog.validateProposal(proposalInput);
      } catch (error) {
        throw mapToApplicationError(error, "POLICY_DENIED");
      }
      if (validated.candidate.kind === "role-prompt") {
        if (!(input.promptContent instanceof Uint8Array)) {
          throw new EvolutionApplicationError(
            "MATERIAL_MISSING",
            "Role-prompt proposals require promptContent at proposal time",
          );
        }
        await this.#ingestPromptMaterial(
          validated.candidate.contentDigest,
          input.promptContent,
        );
      } else if (input.promptContent !== undefined) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          "promptContent is only accepted for role-prompt candidates",
        );
      }
      return await this.#catalog.propose(proposalInput, this.#catalogWriter);
    });
  }

  async beginEvaluation(
    proposalId: string,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      return await this.#catalog.beginEvaluation(
        proposalId,
        new Date(this.#now()).toISOString(),
        this.#catalogWriter,
      );
    });
  }

  async evaluate(
    proposalId: string,
    evidence: unknown,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      return await this.#catalog.evaluate(
        proposalId,
        evidence,
        new Date(this.#now()).toISOString(),
        this.#catalogWriter,
      );
    });
  }

  /**
   * Run the fixed, server-owned Phase-4 structural preflight and bind its
   * evidence directly to the immutable proposal. This does not claim that the
   * candidate has been executed or behaviorally validated.
   */
  async evaluateServerPreflight(
    proposalId: string,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      let proposal = this.#requireProposal(proposalId);
      if (proposal.status === "evaluated") {
        this.#assertServerPreflightEvaluation(proposal);
        return { proposal, committedRevision: this.#catalog.revision };
      }
      if (proposal.status === "proposed") {
        const begun = await this.#catalog.beginEvaluation(
          proposal.id,
          new Date(this.#now()).toISOString(),
          this.#catalogWriter,
        );
        proposal = begun.proposal;
      } else if (proposal.status !== "evaluating") {
        throw new EvolutionApplicationError(
          "INVALID_LIFECYCLE",
          `Proposal '${proposal.id}' cannot run server preflight from status '${proposal.status}'`,
        );
      }

      const candidateDigest = computeCandidateDigest(proposal.candidate);
      const items: Array<{
        kind: "deterministic";
        id: string;
        status: "pass" | "fail";
        summary: string;
      }> = [];
      let trusted = true;
      try {
        this.#assertPolicyAllows(proposal);
        if (proposal.candidate.kind === "strategy-blueprint") {
          if (proposal.policy.allowedPromptPaths.length !== 0) {
            throw new EvolutionApplicationError(
              "POLICY_DENIED",
              "Strategy candidates cannot carry prompt path capabilities",
            );
          }
          const configuredNames = new Set(
            Object.keys(this.#loaded.config.strategies?.definitions ?? {}),
          );
          if (configuredNames.has(proposal.candidate.name)) {
            throw new EvolutionApplicationError(
              "POLICY_DENIED",
              `Configured strategy '${proposal.candidate.name}' is read-only`,
            );
          }
        } else {
          const trustedPaths = new Set(
            Object.values(this.#loaded.config.roles)
              .map((role) => role.promptFile)
              .filter((value): value is string => typeof value === "string"),
          );
          if (
            !trustedPaths.has(proposal.candidate.path) ||
            proposal.policy.allowedPromptPaths.length !== 1 ||
            proposal.policy.allowedPromptPaths[0] !== proposal.candidate.path
          ) {
            throw new EvolutionApplicationError(
              "POLICY_DENIED",
              `Prompt candidate path '${proposal.candidate.path}' is not the exact current trusted path`,
            );
          }
        }
        items.push(serverPreflightItem(
          "server-candidate-trust-v1",
          "pass",
          "Current project trust and bounded capabilities accepted; candidate was not executed",
        ));
      } catch (error) {
        if (!(error instanceof EvolutionApplicationError) || error.code !== "POLICY_DENIED") {
          throw error;
        }
        trusted = false;
        items.push(serverPreflightItem(
          "server-candidate-trust-v1",
          "fail",
          `Current project trust rejected the candidate: ${error.message}; candidate was not executed`,
        ));
      }

      if (proposal.candidate.kind === "strategy-blueprint") {
        if (!trusted) {
          items.push(serverPreflightItem(
            "server-strategy-preflight-v1",
            "fail",
            "Strategy preflight was not run because candidate trust failed; candidate was not executed",
          ));
        } else {
          try {
            this.#strategies.preflight(
              proposal.candidate.name,
              proposal.candidate.definition,
            );
            items.push(serverPreflightItem(
              "server-strategy-preflight-v1",
              "pass",
              "Strategy schema, topology, profiles, and current catalog composition passed; candidate was not executed",
            ));
          } catch (error) {
            if (!(error instanceof StrategyBlueprintError)) throw error;
            items.push(serverPreflightItem(
              "server-strategy-preflight-v1",
              "fail",
              `Strategy preflight rejected the candidate: ${error.message}; candidate was not executed`,
            ));
          }
        }
      } else if (!trusted) {
        items.push(
          serverPreflightItem(
            "server-prompt-object-integrity-v1",
            "fail",
            "Prompt object verification was not run because candidate trust failed; candidate was not executed",
          ),
          serverPreflightItem(
            "server-prompt-target-trust-v1",
            "fail",
            "Prompt target verification was not run because candidate trust failed; candidate was not executed",
          ),
        );
      } else {
        await this.#readPromptObject(proposal.candidate.contentDigest);
        items.push(serverPreflightItem(
          "server-prompt-object-integrity-v1",
          "pass",
          "Content-addressed prompt object digest, size, permissions, and UTF-8 passed; candidate was not executed",
        ));
        try {
          const live = await this.#readTargetState(proposal.candidate);
          if (!live.present || !live.digest) {
            throw new EvolutionApplicationError(
              "POLICY_DENIED",
              `Prompt target '${proposal.candidate.path}' must already exist`,
            );
          }
          await this.#readLivePromptText(proposal.candidate.path, live.digest);
          await this.#git.verifyTrackedRegularFile(proposal.candidate.path);
          items.push(serverPreflightItem(
            "server-prompt-target-trust-v1",
            "pass",
            "Live prompt target is canonical, readable UTF-8, size-bounded, and tracked by HEAD; candidate was not executed",
          ));
        } catch (error) {
          const mapped = error instanceof GitManagerError ? mapGitError(error) : error;
          if (
            !(mapped instanceof EvolutionApplicationError) ||
            (mapped.code !== "POLICY_DENIED" && mapped.code !== "TARGET_DRIFTED")
          ) {
            throw mapped;
          }
          items.push(serverPreflightItem(
            "server-prompt-target-trust-v1",
            "fail",
            `Live prompt target failed trust checks: ${mapped.message}; candidate was not executed`,
          ));
        }
      }

      return await this.#catalog.evaluateServerPreflight(
        proposal.id,
        { proposalId: proposal.id, candidateDigest, items },
        new Date(this.#now()).toISOString(),
        this.#catalogWriter,
      );
    });
  }

  async assertServerPreflightEvaluation(proposalId: string): Promise<void> {
    await this.#enqueue(async () => {
      this.#assertOpen();
      this.#assertServerPreflightEvaluation(this.#requireProposal(proposalId));
    });
  }

  async reject(
    proposalId: string,
    input: { operator: string; reason: string },
  ): Promise<{
    proposal: EvolutionProposal;
    record: RejectionRecord;
    committedRevision: number;
  }> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      return await this.#catalog.reject(proposalId, {
        actor: requireNonEmpty(input.operator, "operator"),
        reason: requireNonEmpty(input.reason, "reason"),
        decidedAt: new Date(this.#now()).toISOString(),
      }, this.#catalogWriter);
    });
  }

  async readCatalogSnapshot(): Promise<{
    revision: number;
    snapshot: EvolutionCatalogSnapshot;
  }> {
    const control = await this.readControlSnapshot();
    return { revision: control.catalogRevision, snapshot: control.catalog };
  }

  async previewPromotion(input: {
    proposalId: string;
    operator: string;
    expectedRevision?: number;
  }): Promise<ApplicationPreview> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      const { revision, snapshot: _snapshot } = await this.#catalog.readSnapshot();
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== revision
      ) {
        throw new EvolutionApplicationError(
          "STALE_CATALOG_REVISION",
          `Catalog revision ${input.expectedRevision} is stale; current is ${revision}`,
        );
      }
      const proposal = this.#requireProposal(input.proposalId);
      this.#assertPolicyAllows(proposal);
      this.#assertPromotable(proposal);
      this.#assertNoUnreconciledConflict(proposal, "promote");

      const candidateDigest = computeCandidateDigest(proposal.candidate);
      const target = targetFromCandidate(proposal.candidate);
      const activeProposalId = this.#catalog.getActiveProposalId(target);
      const beforeTarget = await this.#readTargetState(proposal.candidate);
      const afterTarget = await this.#plannedAfterState(proposal, beforeTarget);
      const previousApplication = activeProposalId
        ? (this.#applications.get(activeProposalId) ?? null)
        : null;
      if (
        previousApplication &&
        !targetStatesEqual(beforeTarget, previousApplication.afterTarget)
      ) {
        throw new EvolutionApplicationError(
          "TARGET_DRIFTED",
          `Active target for '${activeProposalId}' no longer matches its application proof`,
        );
      }
      if (
        previousApplication &&
        applicationHistoryDepth(previousApplication) >= MAX_APPLICATION_HISTORY_DEPTH
      ) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          `Application history for '${targetKey(target)}' reached the bounded depth of ${MAX_APPLICATION_HISTORY_DEPTH}`,
        );
      }
      const operator = requireNonEmpty(input.operator, "operator");
      const expiresAt = new Date(this.#now() + this.#previewTtlMs).toISOString();
      const token = randomBytes(32).toString("base64url");
      const preview: PreviewRecord = {
        token,
        tokenDigest: sha256Text(token),
        kind: "promote-and-apply",
        proposalId: proposal.id,
        candidateDigest,
        catalogRevision: revision,
        activeProposalId,
        currentTargetDigest: beforeTarget.digest,
        operator,
        expiresAt,
        beforeTarget,
        afterTarget,
        previousApplication,
        previousActiveProposalId: activeProposalId,
        expectedCatalogRevisionAfter: revision + 1,
      };
      this.#previews.set(preview.tokenDigest, isolate(preview));
      return toPublicPreview(preview);
    });
  }

  async promoteAndApply(input: {
    commandId: string;
    proposalId: string;
    expectedRevision: number;
    token: string;
    operator: string;
    reason: string;
  }): Promise<ApplicationCommandResult> {
    return await this.#enqueue(async () => {
      return await this.#executeCommand({
        commandId: input.commandId,
        operation: "promote-and-apply",
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        token: input.token,
        operator: input.operator,
        reason: input.reason,
      });
    });
  }

  /** Resolve an already completed exact command without entering a new write. */
  async replayCommand(input: {
    commandId: string;
    operation: "promote-and-apply" | "rollback-applied";
    proposalId: string;
    expectedRevision: number;
    token: string;
    operator: string;
    reason: string;
  }): Promise<ApplicationCommandResult | undefined> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const commandId = requireCommandId(input.commandId);
      const operator = requireNonEmpty(input.operator, "operator");
      const reason = requireNonEmpty(input.reason, "reason");
      const previewTokenDigest = sha256Text(input.token);
      const materialDigest = null;
      const requestDigest = sha256Canonical({
        operation: input.operation,
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        tokenDigest: previewTokenDigest,
        operator,
        reason,
        materialDigest,
      });
      const existing = this.#commands.get(commandId);
      if (!existing) return undefined;
      return this.#dedupeOrConflict(existing, {
        operation: input.operation,
        proposalId: input.proposalId,
        operator,
        reason,
        expectedRevision: input.expectedRevision,
        previewTokenDigest,
        requestDigest,
        materialDigest,
      });
    });
  }

  /** Resolve an already completed exact legacy reconciliation command. */
  async replayReconcileCommand(input: {
    commandId: string;
    proposalId: string;
    expectedRevision: number;
    operator: string;
    reason: string;
    mode: "adopt" | "apply";
    promptContent?: Uint8Array;
  }): Promise<ApplicationCommandResult | undefined> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const commandId = requireCommandId(input.commandId);
      const operator = requireNonEmpty(input.operator, "operator");
      const reason = requireNonEmpty(input.reason, "reason");
      const materialDigest = input.promptContent
        ? sha256Bytes(Buffer.from(input.promptContent))
        : null;
      const requestDigest = sha256Canonical({
        operation: "reconcile-promoted",
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        operator,
        reason,
        mode: input.mode,
        materialDigest,
      });
      const existing = this.#commands.get(commandId);
      if (!existing) return undefined;
      return this.#dedupeOrConflict(existing, {
        operation: "reconcile-promoted",
        proposalId: input.proposalId,
        operator,
        reason,
        expectedRevision: input.expectedRevision,
        previewTokenDigest: `reconcile:${input.mode}`,
        requestDigest,
        materialDigest,
      });
    });
  }

  async previewRollback(input: {
    proposalId: string;
    operator: string;
    expectedRevision?: number;
  }): Promise<ApplicationPreview> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      const { revision } = await this.#catalog.readSnapshot();
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== revision
      ) {
        throw new EvolutionApplicationError(
          "STALE_CATALOG_REVISION",
          `Catalog revision ${input.expectedRevision} is stale; current is ${revision}`,
        );
      }
      const proposal = this.#requireProposal(input.proposalId);
      this.#assertPolicyAllows(proposal);
      if (proposal.status !== "promoted") {
        throw new EvolutionApplicationError(
          "INVALID_LIFECYCLE",
          `Proposal '${proposal.id}' must be promoted to preview rollback (status=${proposal.status})`,
        );
      }
      const target = targetFromCandidate(proposal.candidate);
      const activeProposalId = this.#catalog.getActiveProposalId(target);
      if (activeProposalId !== proposal.id) {
        throw new EvolutionApplicationError(
          "ACTIVE_TARGET_CONFLICT",
          `Proposal '${proposal.id}' is not the active promotion for its target`,
        );
      }
      const application = this.#applications.get(proposal.id);
      if (!application) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Promoted proposal '${proposal.id}' has no application proof; use reconcilePromoted before rollback`,
        );
      }
      if (!application.rollbackSafe) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Reconciled proposal '${proposal.id}' has no verified predecessor material and cannot be rolled back`,
        );
      }

      const candidateDigest = computeCandidateDigest(proposal.candidate);
      const beforeTarget = await this.#readTargetState(proposal.candidate);
      if (!targetStatesEqual(beforeTarget, application.afterTarget)) {
        throw new EvolutionApplicationError(
          "TARGET_DRIFTED",
          `Active target for '${proposal.id}' drifted from applied digest`,
        );
      }
      const afterTarget = await this.#plannedRollbackState(proposal, application);
      const operator = requireNonEmpty(input.operator, "operator");
      const expiresAt = new Date(this.#now() + this.#previewTtlMs).toISOString();
      const token = randomBytes(32).toString("base64url");
      const preview: PreviewRecord = {
        token,
        tokenDigest: sha256Text(token),
        kind: "rollback-applied",
        proposalId: proposal.id,
        candidateDigest,
        catalogRevision: revision,
        activeProposalId,
        currentTargetDigest: beforeTarget.digest,
        operator,
        expiresAt,
        beforeTarget,
        afterTarget,
        previousApplication: application,
        previousActiveProposalId: activeProposalId,
        expectedCatalogRevisionAfter: revision + 1,
      };
      this.#previews.set(preview.tokenDigest, isolate(preview));
      return toPublicPreview(preview);
    });
  }

  async rollbackAppliedPromotion(input: {
    commandId: string;
    proposalId: string;
    expectedRevision: number;
    token: string;
    operator: string;
    reason: string;
  }): Promise<ApplicationCommandResult> {
    return await this.#enqueue(async () => {
      return await this.#executeCommand({
        commandId: input.commandId,
        operation: "rollback-applied",
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        token: input.token,
        operator: input.operator,
        reason: input.reason,
      });
    });
  }

  /**
   * Return the exact human-review material already bound to an unexpired
   * preview. This never accepts a path or replacement content from the caller.
   */
  async describePreview(input: {
    token: string;
    kind: "promote-and-apply" | "rollback-applied";
    proposalId: string;
    operator: string;
    expectedRevision: number;
  }): Promise<ApplicationPreviewDescription> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const preview = this.#consumePreview(input.token, input);
      const proposal = this.#requireProposal(input.proposalId);
      if (proposal.candidate.kind === "strategy-blueprint") {
        if (
          preview.beforeTarget.kind !== "strategy-blueprint" ||
          preview.afterTarget.kind !== "strategy-blueprint"
        ) {
          throw new EvolutionApplicationError(
            "STALE_PREVIEW",
            "Preview target kind no longer matches its proposal",
          );
        }
        return isolate({
          kind: input.kind,
          proposalId: proposal.id,
          before: {
            kind: "strategy-blueprint" as const,
            identity: preview.beforeTarget.identity,
            digest: preview.beforeTarget.digest,
            present: preview.beforeTarget.present,
            definition: preview.beforeTarget.strategyDefinition ?? null,
          },
          after: {
            kind: "strategy-blueprint" as const,
            identity: preview.afterTarget.identity,
            digest: preview.afterTarget.digest,
            present: preview.afterTarget.present,
            definition: preview.afterTarget.strategyDefinition ?? null,
          },
        });
      }

      if (
        preview.beforeTarget.kind !== "role-prompt" ||
        preview.afterTarget.kind !== "role-prompt"
      ) {
        throw new EvolutionApplicationError(
          "STALE_PREVIEW",
          "Preview target kind no longer matches its proposal",
        );
      }
      const live = await this.#readTargetState(proposal.candidate);
      if (!targetStatesEqual(live, preview.beforeTarget)) {
        throw new EvolutionApplicationError(
          "TARGET_DRIFTED",
          "Prompt target changed before preview material was reviewed",
        );
      }
      const beforeContent = preview.beforeTarget.present
        ? await this.#readLivePromptText(proposal.candidate.path, preview.beforeTarget.digest!)
        : null;
      const afterContent = preview.afterTarget.present
        ? decodeUtf8(await this.#readPromptObject(preview.afterTarget.digest!))
        : null;
      return isolate({
        kind: input.kind,
        proposalId: proposal.id,
        before: {
          kind: "role-prompt" as const,
          identity: preview.beforeTarget.identity,
          digest: preview.beforeTarget.digest,
          present: preview.beforeTarget.present,
          content: beforeContent,
        },
        after: {
          kind: "role-prompt" as const,
          identity: preview.afterTarget.identity,
          digest: preview.afterTarget.digest,
          present: preview.afterTarget.present,
          content: afterContent,
        },
      });
    });
  }

  /**
   * Explicit human reconciliation for Phase-2 promotions that lack application
   * proof. When `mode` is `adopt`, the live target digest must already match the
   * candidate; when `mode` is `apply`, material is applied through the journal.
   */
  async reconcilePromoted(input: {
    commandId: string;
    proposalId: string;
    expectedRevision: number;
    operator: string;
    reason: string;
    mode: "adopt" | "apply";
    /** Legacy Phase-2 prompt material; accepted only by reconcile/apply. */
    promptContent?: Uint8Array;
  }): Promise<ApplicationCommandResult> {
    return await this.#enqueue(async () => {
      this.#assertOpen();
      const commandId = requireCommandId(input.commandId);
      const operator = requireNonEmpty(input.operator, "operator");
      const reason = requireNonEmpty(input.reason, "reason");
      if (
        input.promptContent !== undefined &&
        !(input.promptContent instanceof Uint8Array)
      ) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          "Legacy prompt material must be bytes",
        );
      }
      if (input.mode === "adopt" && input.promptContent !== undefined) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          "Legacy prompt material is not accepted when adopting the live target",
        );
      }
      const materialDigest =
        input.promptContent === undefined ? null : sha256Bytes(Buffer.from(input.promptContent));
      const requestDigest = sha256Canonical({
        operation: "reconcile-promoted",
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        operator,
        reason,
        mode: input.mode,
        materialDigest,
      });
      const existing = this.#commands.get(commandId);
      if (existing) {
        return this.#dedupeOrConflict(existing, {
          operation: "reconcile-promoted",
          proposalId: input.proposalId,
          operator,
          reason,
          expectedRevision: input.expectedRevision,
          previewTokenDigest: `reconcile:${input.mode}`,
          requestDigest,
          materialDigest,
        });
      }
      this.#assertWritable();

      const { revision, snapshot } = await this.#catalog.readSnapshot();
      if (input.expectedRevision !== revision) {
        throw new EvolutionApplicationError(
          "STALE_CATALOG_REVISION",
          `Catalog revision ${input.expectedRevision} is stale; current is ${revision}`,
        );
      }
      const proposal = this.#requireProposal(input.proposalId);
      this.#assertPolicyAllows(proposal);
      if (proposal.status !== "promoted") {
        throw new EvolutionApplicationError(
          "INVALID_LIFECYCLE",
          `Proposal '${proposal.id}' must be promoted to reconcile (status=${proposal.status})`,
        );
      }
      if (this.#applications.has(proposal.id)) {
        throw new EvolutionApplicationError(
          "INVALID_LIFECYCLE",
          `Proposal '${proposal.id}' already has application proof`,
        );
      }
      const target = targetFromCandidate(proposal.candidate);
      const activeProposalId = this.#catalog.getActiveProposalId(target);
      if (activeProposalId !== proposal.id) {
        throw new EvolutionApplicationError(
          "ACTIVE_TARGET_CONFLICT",
          `Proposal '${proposal.id}' is not the active promotion for its target`,
        );
      }

      const decidedAt = new Date(this.#now()).toISOString();
      const humanDecision = parseHumanDecision({
        actor: operator,
        reason,
        decidedAt,
      });
      const candidateDigest = computeCandidateDigest(proposal.candidate);
      const beforeTarget = await this.#readTargetState(proposal.candidate);
      let livePromptContent: Buffer | undefined;
      if (proposal.candidate.kind === "role-prompt") {
        if (!beforeTarget.present || !beforeTarget.digest) {
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Prompt target '${proposal.candidate.path}' must already exist for reconciliation`,
          );
        }
        livePromptContent = await this.#readLivePromptBytes(
          proposal.candidate.path,
          beforeTarget.digest,
        );
      }
      const rollbackPreflight = await this.#catalog.preflightRollback(
        proposal.id,
        humanDecision,
      );
      const legacyPredecessor = await this.#resolveLegacyPredecessor({
        snapshot,
        restoredProposalId: rollbackPreflight.record.restoredActiveProposalId,
        liveTarget: beforeTarget,
        mode: input.mode,
        catalogRevision: revision,
        operator,
        reason,
        decidedAt,
        humanDecision,
        commandId,
      });
      if (
        legacyPredecessor.application &&
        applicationHistoryDepth(legacyPredecessor.application) >= MAX_APPLICATION_HISTORY_DEPTH
      ) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          `Application history for '${targetKey(target)}' reached the bounded depth of ${MAX_APPLICATION_HISTORY_DEPTH}`,
        );
      }
      const applicationBeforeTarget = legacyPredecessor.application?.afterTarget ?? beforeTarget;

      if (input.mode === "adopt") {
        await this.#assertQuiescentSafe();
        const expectedDigest =
          proposal.candidate.kind === "role-prompt"
            ? proposal.candidate.contentDigest
            : sha256Canonical(proposal.candidate.definition);
        if (beforeTarget.digest !== expectedDigest) {
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Cannot adopt proposal '${proposal.id}': live target digest does not match candidate`,
          );
        }
        if (livePromptContent) {
          await this.#ingestPromptMaterial(beforeTarget.digest!, livePromptContent);
        }
        const application: ApplicationRecord = {
          proposalId: proposal.id,
          candidateDigest,
          target,
          status: "adopted",
          beforeTargetDigest: applicationBeforeTarget.digest,
          afterTargetDigest: beforeTarget.digest!,
          beforeTarget: applicationBeforeTarget,
          afterTarget: beforeTarget,
          previousApplication: legacyPredecessor.application,
          rollbackSafe: legacyPredecessor.application !== null,
          catalogRevision: revision,
          operator,
          reason,
          appliedAt: decidedAt,
          commandId,
        };
        if (legacyPredecessor.completion) {
          this.#completed.push(legacyPredecessor.completion);
        }
        if (legacyPredecessor.application) {
          this.#applications.delete(legacyPredecessor.application.proposalId);
        }
        this.#applications.set(proposal.id, application);
        const completed: CompletedApplicationRecord = {
          commandId,
          operation: "reconcile-promoted",
          proposalId: proposal.id,
          candidateDigest,
          status: "adopted",
          beforeTargetDigest: applicationBeforeTarget.digest,
          afterTargetDigest: beforeTarget.digest,
          catalogRevisionBefore: revision,
          catalogRevisionAfter: revision,
          operator,
          reason,
          completedAt: decidedAt,
          humanDecision,
        };
        this.#completed.push(completed);
        const resultPayload: ApplicationCommandResultPayload = {
          proposal,
          committedCatalogRevision: revision,
          applicationStatus: "adopted",
          beforeTargetDigest: applicationBeforeTarget.digest,
          afterTargetDigest: beforeTarget.digest,
        };
        const binding: CommandIdempotencyBinding = {
          commandId,
          operation: "reconcile-promoted",
          proposalId: proposal.id,
          candidateDigest,
          operator,
          reason,
          expectedRevision: input.expectedRevision,
          previewTokenDigest: `reconcile:${input.mode}`,
          requestDigest,
          materialDigest,
          result: resultPayload,
        };
        this.#commands.set(commandId, binding);
        await this.#persistApplicationState(this.#revision + 1);
        return {
          proposal,
          committedCatalogRevision: revision,
          applicationStatus: "adopted",
          beforeTargetDigest: applicationBeforeTarget.digest,
          afterTargetDigest: beforeTarget.digest,
          deduplicated: false,
        };
      }

      // mode === "apply": journaled apply without catalog promote (already promoted)
      if (proposal.candidate.kind === "role-prompt") {
        if (input.promptContent instanceof Uint8Array) {
          await this.#ingestPromptMaterial(
            proposal.candidate.contentDigest,
            input.promptContent,
          );
        } else {
          await this.#readPromptObject(proposal.candidate.contentDigest);
        }
      } else if (input.promptContent !== undefined) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          "Legacy prompt material is only accepted for role-prompt reconciliation",
        );
      }
      const afterTarget = await this.#plannedAfterState(proposal, beforeTarget);
      await this.#assertQuiescentSafe();
      let gitAuthorization: ExactTrackedFileCommitAuthorization | undefined;
      if (proposal.candidate.kind === "role-prompt") {
        try {
          gitAuthorization = await this.#git.authorizeExactTrackedFileCommit(
            proposal.candidate.path,
          );
        } catch (error) {
          throw mapGitError(error);
        }
      }
      if (livePromptContent) {
        await this.#ingestPromptMaterial(beforeTarget.digest!, livePromptContent);
      }
      const previewTokenDigest = `reconcile:${input.mode}`;
      const pending: PendingApplicationOperation = {
        commandId,
        operation: "reconcile-promoted",
        proposalId: proposal.id,
        candidateDigest,
        operator,
        reason,
        humanDecision,
        catalogRevisionBefore: revision,
        expectedCatalogRevisionAfter: revision,
        beforeTarget: applicationBeforeTarget,
        afterTarget,
        previousActiveProposalId: activeProposalId,
        previousApplication: legacyPredecessor.application,
        previewTokenDigest,
        requestDigest,
        materialDigest,
        expectedAuditDigest: null,
        gitBaseHead: gitAuthorization?.head ?? null,
        gitPath: gitAuthorization?.repositoryRelativePath ?? null,
        startedAt: decidedAt,
      };
      if (legacyPredecessor.completion) {
        this.#completed.push(legacyPredecessor.completion);
      }
      this.#pending = pending;
      await this.#persistApplicationState(this.#revision + 1);

      try {
        await this.#applyTarget(
          proposal,
          beforeTarget,
          afterTarget,
          humanDecision,
          "apply",
          gitAuthorization,
        );
      } catch (error) {
        const mapped = mapToApplicationError(error);
        // Target not applied (or indeterminate handled inside). Clear pending as aborted only if still old.
        const live = await this.#readTargetState(proposal.candidate);
        if (mapped.code !== "RECOVERY_REQUIRED" && live.digest === beforeTarget.digest) {
          await this.#finalizePendingAs("aborted", revision, live.digest);
        } else {
          this.#recoveryRequired = true;
          await this.#persistApplicationState(this.#revision + 1).catch(() => undefined);
          throw mapToApplicationError(error, "RECOVERY_REQUIRED");
        }
        throw mapped;
      }

      const liveAfter = await this.#readTargetState(proposal.candidate);
      if (!targetStatesEqual(liveAfter, afterTarget)) {
        this.#recoveryRequired = true;
        await this.#persistApplicationState(this.#revision + 1).catch(() => undefined);
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Target apply completed with unexpected digest; manual recovery required",
        );
      }

      const application: ApplicationRecord = {
        proposalId: proposal.id,
        candidateDigest,
        target,
        status: "applied",
        beforeTargetDigest: applicationBeforeTarget.digest,
        afterTargetDigest: afterTarget.digest!,
        beforeTarget: applicationBeforeTarget,
        afterTarget,
        previousApplication: legacyPredecessor.application,
        rollbackSafe: true,
        catalogRevision: revision,
        operator,
        reason,
        appliedAt: decidedAt,
        commandId,
      };
      if (legacyPredecessor.application) {
        this.#applications.delete(legacyPredecessor.application.proposalId);
      }
      this.#applications.set(proposal.id, application);
      const completed: CompletedApplicationRecord = {
        commandId,
        operation: "reconcile-promoted",
        proposalId: proposal.id,
        candidateDigest,
        status: "applied",
        beforeTargetDigest: applicationBeforeTarget.digest,
        afterTargetDigest: afterTarget.digest,
        catalogRevisionBefore: revision,
        catalogRevisionAfter: revision,
        operator,
        reason,
        completedAt: new Date(this.#now()).toISOString(),
        humanDecision,
      };
      this.#completed.push(completed);
      this.#pending = null;
      const resultPayload: ApplicationCommandResultPayload = {
        proposal,
        committedCatalogRevision: revision,
        applicationStatus: "applied",
        beforeTargetDigest: applicationBeforeTarget.digest,
        afterTargetDigest: afterTarget.digest,
      };
      this.#commands.set(commandId, {
        commandId,
        operation: "reconcile-promoted",
        proposalId: proposal.id,
        candidateDigest,
        operator,
        reason,
        expectedRevision: input.expectedRevision,
        previewTokenDigest: `reconcile:${input.mode}`,
        requestDigest,
        materialDigest,
        result: resultPayload,
      });
      await this.#persistApplicationState(this.#revision + 1);
      return {
        proposal,
        committedCatalogRevision: revision,
        applicationStatus: "applied",
        beforeTargetDigest: applicationBeforeTarget.digest,
        afterTargetDigest: afterTarget.digest,
        deduplicated: false,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Internal command execution
  // ---------------------------------------------------------------------------

  async #executeCommand(input: {
    commandId: string;
    operation: "promote-and-apply" | "rollback-applied";
    proposalId: string;
    expectedRevision: number;
    token: string;
    operator: string;
    reason: string;
  }): Promise<ApplicationCommandResult> {
    this.#assertOpen();
    const commandId = requireCommandId(input.commandId);
    const operator = requireNonEmpty(input.operator, "operator");
    const reason = requireNonEmpty(input.reason, "reason");
    const tokenDigest = sha256Text(input.token);
    const materialDigest = null;
    const requestDigest = sha256Canonical({
      operation: input.operation,
      proposalId: input.proposalId,
      expectedRevision: input.expectedRevision,
      tokenDigest,
      operator,
      reason,
      materialDigest,
    });
    const existing = this.#commands.get(commandId);
    if (existing) {
      return this.#dedupeOrConflict(existing, {
        operation: input.operation,
        proposalId: input.proposalId,
        operator,
        reason,
        expectedRevision: input.expectedRevision,
        previewTokenDigest: tokenDigest,
        requestDigest,
        materialDigest,
      });
    }
    this.#assertWritable();

    const preview = this.#consumePreview(input.token, {
      kind: input.operation,
      proposalId: input.proposalId,
      operator,
      expectedRevision: input.expectedRevision,
    });

    const { revision } = await this.#catalog.readSnapshot();
    if (revision !== input.expectedRevision || revision !== preview.catalogRevision) {
      throw new EvolutionApplicationError(
        "STALE_CATALOG_REVISION",
        `Catalog revision mismatch: command expected ${input.expectedRevision}, preview ${preview.catalogRevision}, current ${revision}`,
      );
    }

    const proposal = this.#requireProposal(input.proposalId);
    this.#assertPolicyAllows(proposal);
    const candidateDigest = computeCandidateDigest(proposal.candidate);
    if (candidateDigest !== preview.candidateDigest) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview candidate digest no longer matches proposal",
      );
    }

    const decidedAt = new Date(this.#now()).toISOString();
    const humanDecision = parseHumanDecision({
      actor: operator,
      reason,
      decidedAt,
    });

    if (input.operation === "promote-and-apply") {
      this.#assertPromotable(proposal);
      this.#assertNoUnreconciledConflict(proposal, "promote");
    } else {
      if (proposal.status !== "promoted") {
        throw new EvolutionApplicationError(
          "INVALID_LIFECYCLE",
          `Proposal '${proposal.id}' must be promoted to rollback`,
        );
      }
      if (!this.#applications.has(proposal.id)) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Promoted proposal '${proposal.id}' has no application proof`,
        );
      }
    }

    const liveBefore = await this.#readTargetState(proposal.candidate);
    if (!targetStatesEqual(liveBefore, preview.beforeTarget)) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        "Target digest changed since preview",
      );
    }
    const activeNow = this.#catalog.getActiveProposalId(targetFromCandidate(proposal.candidate));
    if (activeNow !== preview.activeProposalId) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Active proposal pointer changed since preview",
      );
    }
    const recomputedAfter =
      input.operation === "promote-and-apply"
        ? await this.#plannedAfterState(proposal, liveBefore)
        : await this.#plannedRollbackState(
            proposal,
            this.#applications.get(proposal.id)!,
          );
    if (sha256Canonical(recomputedAfter) !== sha256Canonical(preview.afterTarget)) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview target plan no longer matches current proposal state",
      );
    }

    await this.#assertQuiescentSafe();

    const preflight =
      input.operation === "promote-and-apply"
        ? await this.#catalog.preflightPromote(
            proposal.id,
            proposal.evaluation?.evidence,
            humanDecision,
            commandId,
          )
        : await this.#catalog.preflightRollback(proposal.id, humanDecision, commandId);
    if (input.operation === "rollback-applied") {
      const restoredId = (preflight.record as RollbackRecord).restoredActiveProposalId;
      const provenPredecessorId =
        preview.previousApplication?.previousApplication?.proposalId ?? null;
      if (restoredId !== provenPredecessorId) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Application predecessor proof does not match catalog rollback provenance",
        );
      }
    }
    const expectedAuditDigest = sha256Canonical(preflight.record);
    let gitAuthorization: ExactTrackedFileCommitAuthorization | undefined;
    if (proposal.candidate.kind === "role-prompt") {
      try {
        gitAuthorization = await this.#git.authorizeExactTrackedFileCommit(
          proposal.candidate.path,
        );
      } catch (error) {
        throw mapGitError(error);
      }
    }
    const pending: PendingApplicationOperation = {
      commandId,
      operation: input.operation,
      proposalId: proposal.id,
      candidateDigest,
      operator,
      reason,
      humanDecision,
      catalogRevisionBefore: revision,
      expectedCatalogRevisionAfter: preview.expectedCatalogRevisionAfter,
      beforeTarget: preview.beforeTarget,
      afterTarget: preview.afterTarget,
      previousActiveProposalId: preview.previousActiveProposalId,
      previousApplication: preview.previousApplication,
      previewTokenDigest: tokenDigest,
      requestDigest,
      materialDigest,
      expectedAuditDigest,
      gitBaseHead: gitAuthorization?.head ?? null,
      gitPath: gitAuthorization?.repositoryRelativePath ?? null,
      startedAt: decidedAt,
    };
    this.#pending = pending;
    await this.#persistApplicationState(this.#revision + 1);
    this.#previews.delete(tokenDigest);

    // 1) Target apply
    try {
      if (input.operation === "promote-and-apply") {
        await this.#applyTarget(
          proposal,
          preview.beforeTarget,
          preview.afterTarget,
          humanDecision,
          "apply",
          gitAuthorization,
        );
      } else {
        await this.#applyTarget(
          proposal,
          preview.beforeTarget,
          preview.afterTarget,
          humanDecision,
          "rollback",
          gitAuthorization,
        );
      }
    } catch (error) {
      const mapped = mapToApplicationError(error);
      const live = await this.#readTargetState(proposal.candidate).catch(() => null);
      if (
        mapped.code !== "RECOVERY_REQUIRED" &&
        live &&
        live.digest === preview.beforeTarget.digest
      ) {
        await this.#finalizePendingAs("aborted", revision, live.digest);
        throw mapped;
      }
      this.#recoveryRequired = true;
      await this.#persistApplicationState(this.#revision + 1).catch(() => undefined);
      throw mapToApplicationError(error, "RECOVERY_REQUIRED");
    }

    const liveAfterTarget = await this.#readTargetState(proposal.candidate);
    if (!targetStatesEqual(liveAfterTarget, preview.afterTarget)) {
      this.#recoveryRequired = true;
      await this.#persistApplicationState(this.#revision + 1).catch(() => undefined);
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Target mutation produced an unexpected digest",
      );
    }

    // 2) Catalog promote / rollback
    let catalogResult: {
      proposal: EvolutionProposal;
      record: PromotionRecord | RollbackRecord;
      committedRevision: number;
    };
    try {
      if (input.operation === "promote-and-apply") {
        const evidence = proposal.evaluation?.evidence;
        if (!evidence) {
          throw new EvolutionApplicationError(
            "EVALUATION_NOT_PASSED",
            `Proposal '${proposal.id}' has no evaluation evidence`,
          );
        }
        catalogResult = await this.#catalog.promote(
          proposal.id,
          evidence,
          humanDecision,
          this.#catalogWriter,
          commandId,
        );
      } else {
        catalogResult = await this.#catalog.rollback(
          proposal.id,
          humanDecision,
          this.#catalogWriter,
          commandId,
        );
      }
    } catch (error) {
      // Target is new, catalog is old => leave pending for open-reconcile to finish catalog.
      this.#recoveryRequired = false;
      await this.#persistApplicationState(this.#revision + 1).catch(() => undefined);
      throw mapToApplicationError(error, "RECOVERY_REQUIRED");
    }

    if (sha256Canonical(catalogResult.record) !== pending.expectedAuditDigest) {
      this.#recoveryRequired = true;
      await this.#persistApplicationState(this.#revision + 1).catch(() => undefined);
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Committed catalog audit does not match the preflight transition",
      );
    }

    // 3) Finalize journal
    const finalProposal = catalogResult.proposal;
    if (input.operation === "promote-and-apply") {
      // Replace previous application on same target if any
      if (preview.previousActiveProposalId && preview.previousActiveProposalId !== proposal.id) {
        this.#applications.delete(preview.previousActiveProposalId);
      }
      this.#applications.set(proposal.id, {
        proposalId: proposal.id,
        candidateDigest,
        target: targetFromCandidate(proposal.candidate),
        status: "applied",
        beforeTargetDigest: preview.beforeTarget.digest,
        afterTargetDigest: preview.afterTarget.digest!,
        beforeTarget: preview.beforeTarget,
        afterTarget: preview.afterTarget,
        previousApplication: preview.previousApplication,
        rollbackSafe: true,
        catalogRevision: catalogResult.committedRevision,
        operator,
        reason,
        appliedAt: decidedAt,
        commandId,
      });
    } else {
      this.#applications.delete(proposal.id);
      const restoredId = (catalogResult.record as RollbackRecord).restoredActiveProposalId;
      const prior = preview.previousApplication?.previousApplication ?? null;
      if (restoredId && prior?.proposalId === restoredId) {
        this.#applications.set(restoredId, prior);
      }
    }

    const applicationStatus: ApplicationStatus =
      input.operation === "promote-and-apply" ? "applied" : "rolled-back";
    const completed: CompletedApplicationRecord = {
      commandId,
      operation: input.operation,
      proposalId: proposal.id,
      candidateDigest,
      status: applicationStatus,
      beforeTargetDigest: preview.beforeTarget.digest,
      afterTargetDigest: preview.afterTarget.digest,
      catalogRevisionBefore: revision,
      catalogRevisionAfter: catalogResult.committedRevision,
      operator,
      reason,
      completedAt: new Date(this.#now()).toISOString(),
      humanDecision,
    };
    this.#completed.push(completed);
    this.#pending = null;

    const resultPayload: ApplicationCommandResultPayload = {
      proposal: finalProposal,
      committedCatalogRevision: catalogResult.committedRevision,
      applicationStatus,
      beforeTargetDigest: preview.beforeTarget.digest,
      afterTargetDigest: preview.afterTarget.digest,
    };
    this.#commands.set(commandId, {
      commandId,
      operation: input.operation,
      proposalId: proposal.id,
      candidateDigest,
      operator,
      reason,
      expectedRevision: input.expectedRevision,
      previewTokenDigest: tokenDigest,
      requestDigest,
      materialDigest,
      result: resultPayload,
    });
    await this.#persistApplicationState(this.#revision + 1);

    return {
      proposal: finalProposal,
      committedCatalogRevision: catalogResult.committedRevision,
      applicationStatus,
      beforeTargetDigest: preview.beforeTarget.digest,
      afterTargetDigest: preview.afterTarget.digest,
      deduplicated: false,
    };
  }

  #dedupeOrConflict(
    existing: CommandIdempotencyBinding,
    attempt: {
      operation: ApplicationCommandKind;
      proposalId: string;
      operator: string;
      reason: string;
      expectedRevision: number;
      previewTokenDigest: string;
      requestDigest: string;
      materialDigest: string | null;
    },
  ): ApplicationCommandResult {
    if (
      existing.operation !== attempt.operation ||
      existing.proposalId !== attempt.proposalId ||
      existing.operator !== attempt.operator ||
      existing.reason !== attempt.reason ||
      existing.expectedRevision !== attempt.expectedRevision ||
      existing.previewTokenDigest !== attempt.previewTokenDigest ||
      existing.requestDigest !== attempt.requestDigest ||
      existing.materialDigest !== attempt.materialDigest
    ) {
      throw new EvolutionApplicationError(
        "COMMAND_CONFLICT",
        `commandId '${existing.commandId}' was already used with different parameters`,
      );
    }
    return {
      proposal: isolate(existing.result.proposal),
      committedCatalogRevision: existing.result.committedCatalogRevision,
      applicationStatus: existing.result.applicationStatus,
      beforeTargetDigest: existing.result.beforeTargetDigest,
      afterTargetDigest: existing.result.afterTargetDigest,
      deduplicated: true,
    };
  }

  #consumePreview(
    token: string,
    expected: {
      kind: ApplicationCommandKind;
      proposalId: string;
      operator: string;
      expectedRevision: number;
    },
  ): PreviewRecord {
    if (typeof token !== "string" || !token.trim()) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token is required");
    }
    const digest = sha256Text(token);
    const preview = this.#previews.get(digest);
    if (!preview) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token is unknown or already used");
    }
    if (preview.kind !== expected.kind || preview.proposalId !== expected.proposalId) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview token does not match command kind or proposal",
      );
    }
    if (preview.operator !== expected.operator) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview token operator does not match command operator",
      );
    }
    if (preview.catalogRevision !== expected.expectedRevision) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview token catalog revision does not match expectedRevision",
      );
    }
    if (Date.parse(preview.expiresAt) <= this.#now()) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token has expired");
    }
    // Constant-time compare of token material when present
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(preview.token);
    if (
      tokenBuf.length !== expectedBuf.length ||
      !timingSafeEqual(tokenBuf, expectedBuf)
    ) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token mismatch");
    }
    return preview;
  }

  // ---------------------------------------------------------------------------
  // Target read / apply
  // ---------------------------------------------------------------------------

  async #readTargetState(candidate: EvolutionCandidate): Promise<TargetDigestState> {
    if (candidate.kind === "role-prompt") {
      const absolute = path.resolve(this.#catalog.root, candidate.path);
      assertCanonicalInsideRoot(this.#catalog.root, absolute, "Prompt target");
      try {
        const info = await this.#io.lstat(absolute);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Prompt target must be a regular non-symlink file: ${candidate.path}`,
          );
        }
        if ((info.mode & 0o7000) !== 0 || (await this.#io.realpath(absolute)) !== absolute) {
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Prompt target must not traverse symbolic links or use special permissions: ${candidate.path}`,
          );
        }
        const bytes = await this.#io.readFile(absolute);
        return {
          kind: "role-prompt",
          identity: candidate.path,
          digest: sha256Bytes(bytes),
          present: true,
          mode: info.mode & 0o777,
        };
      } catch (error) {
        if (isNotFound(error)) {
          return {
            kind: "role-prompt",
            identity: candidate.path,
            digest: null,
            present: false,
          };
        }
        throw error;
      }
    }

    const current = this.#strategies.customDefinition(candidate.name);
    if (!current) {
      return {
        kind: "strategy-blueprint",
        identity: candidate.name,
        digest: null,
        present: false,
        strategyDefinition: null,
      };
    }
    return {
      kind: "strategy-blueprint",
      identity: candidate.name,
      digest: sha256Canonical(current),
      present: true,
      strategyDefinition: current,
    };
  }

  async #readLivePromptText(relativePath: string, expectedDigest: string): Promise<string> {
    return decodeUtf8(await this.#readLivePromptBytes(relativePath, expectedDigest));
  }

  async #readLivePromptBytes(relativePath: string, expectedDigest: string): Promise<Buffer> {
    const absolute = path.resolve(this.#catalog.root, relativePath);
    assertCanonicalInsideRoot(this.#catalog.root, absolute, "Prompt target");
    const bytes = await this.#io.readFile(absolute);
    if (
      bytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES ||
      sha256Bytes(bytes) !== expectedDigest
    ) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' changed or exceeds the review limit`,
      );
    }
    try {
      decodeUtf8(bytes);
    } catch {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' is not valid UTF-8`,
      );
    }
    return bytes;
  }

  async #resolveLegacyPredecessor(input: {
    snapshot: EvolutionCatalogSnapshot;
    restoredProposalId: string | null;
    liveTarget: TargetDigestState;
    mode: "adopt" | "apply";
    catalogRevision: number;
    operator: string;
    reason: string;
    decidedAt: string;
    humanDecision: HumanDecision;
    commandId: string;
  }): Promise<{
    application: ApplicationRecord | null;
    completion: CompletedApplicationRecord | null;
  }> {
    if (input.restoredProposalId === null) {
      return { application: null, completion: null };
    }

    const existing = this.#applications.get(input.restoredProposalId);
    if (existing) {
      if (
        targetKey(existing.target) !== targetKeyFromState(input.liveTarget) ||
        (input.mode === "apply" && !targetStatesEqual(existing.afterTarget, input.liveTarget))
      ) {
        throw new EvolutionApplicationError(
          "TARGET_DRIFTED",
          `Legacy predecessor '${existing.proposalId}' does not match the observed target`,
        );
      }
      return { application: isolate(existing), completion: null };
    }

    if (input.mode === "adopt") {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Cannot adopt a legacy promotion whose predecessor '${input.restoredProposalId}' has no application proof`,
      );
    }

    const predecessor = input.snapshot.proposals.find(
      (proposal) => proposal.id === input.restoredProposalId,
    );
    if (!predecessor) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Legacy predecessor '${input.restoredProposalId}' is missing from the catalog`,
      );
    }
    const expectedTarget = await this.#plannedAfterState(predecessor, input.liveTarget);
    if (!targetStatesEqual(expectedTarget, input.liveTarget)) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Observed target does not match legacy predecessor '${predecessor.id}'`,
      );
    }

    const syntheticCommandId = `legacy:${sha256Canonical({
      commandId: input.commandId,
      proposalId: predecessor.id,
      target: input.liveTarget,
    })}`;
    const candidateDigest = computeCandidateDigest(predecessor.candidate);
    const application: ApplicationRecord = {
      proposalId: predecessor.id,
      candidateDigest,
      target: targetFromCandidate(predecessor.candidate),
      status: "adopted",
      beforeTargetDigest: input.liveTarget.digest,
      afterTargetDigest: input.liveTarget.digest!,
      beforeTarget: input.liveTarget,
      afterTarget: input.liveTarget,
      previousApplication: null,
      rollbackSafe: false,
      catalogRevision: input.catalogRevision,
      operator: input.operator,
      reason: `Captured verified legacy predecessor while reconciling: ${input.reason}`,
      appliedAt: input.decidedAt,
      commandId: syntheticCommandId,
    };
    const completion: CompletedApplicationRecord = {
      commandId: syntheticCommandId,
      operation: "reconcile-promoted",
      proposalId: predecessor.id,
      candidateDigest,
      status: "adopted",
      beforeTargetDigest: input.liveTarget.digest,
      afterTargetDigest: input.liveTarget.digest,
      catalogRevisionBefore: input.catalogRevision,
      catalogRevisionAfter: input.catalogRevision,
      operator: input.operator,
      reason: application.reason,
      completedAt: input.decidedAt,
      humanDecision: input.humanDecision,
    };
    return { application: isolate(application), completion: isolate(completion) };
  }

  async #plannedAfterState(
    proposal: EvolutionProposal,
    before: TargetDigestState,
  ): Promise<TargetDigestState> {
    if (proposal.candidate.kind === "role-prompt") {
      return {
        kind: "role-prompt",
        identity: proposal.candidate.path,
        digest: proposal.candidate.contentDigest,
        present: true,
        ...(before.mode === undefined ? {} : { mode: before.mode }),
      };
    }
    return {
      kind: "strategy-blueprint",
      identity: proposal.candidate.name,
      digest: sha256Canonical(proposal.candidate.definition),
      present: true,
      strategyDefinition: proposal.candidate.definition as NamedStrategy,
    };
  }

  async #plannedRollbackState(
    proposal: EvolutionProposal,
    application: ApplicationRecord,
  ): Promise<TargetDigestState> {
    if (proposal.candidate.kind === "role-prompt") {
      // Restore bytes from object store using before digest when present; absence means empty not allowed
      // Prompt files must always remain existing tracked files — restore previous content from objects.
      if (application.beforeTargetDigest === null) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Cannot roll back prompt application without a recorded before digest",
        );
      }
      return {
        ...application.beforeTarget,
      };
    }

    return isolate(application.beforeTarget);
  }

  async #applyTarget(
    proposal: EvolutionProposal,
    before: TargetDigestState,
    after: TargetDigestState,
    decision: HumanDecision,
    mode: "apply" | "rollback",
    gitAuthorization?: ExactTrackedFileCommitAuthorization,
  ): Promise<void> {
    if (proposal.candidate.kind === "role-prompt") {
      if (!gitAuthorization) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Prompt mutation is missing its pre-mutation Git authorization",
        );
      }
      await this.#applyPromptTarget(
        proposal,
        before,
        after.digest!,
        decision,
        mode,
        gitAuthorization,
      );
      return;
    }
    await this.#applyStrategyTarget(proposal, before, after, mode);
  }

  async #applyPromptTarget(
    proposal: EvolutionProposal,
    expectedBefore: TargetDigestState,
    desiredDigest: string,
    decision: HumanDecision,
    mode: "apply" | "rollback",
    authorization: ExactTrackedFileCommitAuthorization,
  ): Promise<void> {
    if (proposal.candidate.kind !== "role-prompt") {
      throw new EvolutionApplicationError("POLICY_DENIED", "Not a role-prompt candidate");
    }
    const relativePath = proposal.candidate.path;
    // Configured promptFile only
    const configured = Object.values(this.#loaded.config.roles ?? {}).some(
      (role) => role && typeof role === "object" && role.promptFile === relativePath,
    );
    if (!configured) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        `Prompt path '${relativePath}' is not a configured role promptFile`,
      );
    }

    const content = await this.#readPromptObject(desiredDigest);
    const absolute = path.resolve(this.#catalog.root, relativePath);
    assertCanonicalInsideRoot(this.#catalog.root, absolute, "Prompt target");

    // Must already exist as tracked regular file — never create/delete
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await this.#io.lstat(absolute);
    } catch (error) {
      if (isNotFound(error)) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt target '${relativePath}' does not exist; evolution never creates prompt files`,
        );
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target must be a regular non-symlink file: ${relativePath}`,
      );
    }
    if ((info.mode & 0o7000) !== 0) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' must not use special permission bits`,
      );
    }
    const canonicalTarget = await this.#io.realpath(absolute);
    if (canonicalTarget !== absolute) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' must not traverse symbolic links`,
      );
    }

    // Snapshot current bytes into the local object store for recovery/rollback.
    // Prompt files must contain no secrets; these objects are local recovery only.
    const currentBytes = await this.#io.readFile(absolute);
    if (
      sha256Bytes(currentBytes) !== expectedBefore.digest ||
      (expectedBefore.mode !== undefined && (info.mode & 0o777) !== expectedBefore.mode)
    ) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' changed after preview`,
      );
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(currentBytes);
    } catch {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' is not valid UTF-8`,
      );
    }
    if (currentBytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Prompt target '${relativePath}' exceeds material size limit`,
      );
    }
    await this.#ingestPromptMaterial(sha256Bytes(currentBytes), currentBytes);

    const directory = path.dirname(absolute);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(absolute)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let renamed = false;
    try {
      await this.#io.beforeAtomicStage?.("open");
      const handle = await this.#io.open(temporaryPath, "wx", info.mode & 0o777);
      try {
        await this.#io.beforeAtomicStage?.("write");
        await handle.writeFile(content);
        await this.#io.chmod(temporaryPath, info.mode & 0o777);
        await this.#io.beforeAtomicStage?.("file-sync");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#io.beforeAtomicStage?.("rename");
      if ((await this.#io.realpath(directory)) !== directory) {
        throw new EvolutionApplicationError(
          "TARGET_DRIFTED",
          `Prompt parent directory changed before rename: ${relativePath}`,
        );
      }
      await this.#io.rename(temporaryPath, absolute);
      renamed = true;
      await this.#io.beforeAtomicStage?.("directory-sync");
      await this.#io.syncDirectory(directory);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (renamed) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Prompt rename completed but directory fsync failed; recovery required: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Failed to write prompt target '${relativePath}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Verify digest after write
    const written = await this.#io.readFile(absolute);
    const writtenDigest = sha256Bytes(written);
    if (writtenDigest !== desiredDigest) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt target digest mismatch after write for '${relativePath}'`,
      );
    }
    const writtenInfo = await this.#io.lstat(absolute);
    if (!writtenInfo.isFile() || writtenInfo.isSymbolicLink() || (writtenInfo.mode & 0o777) !== (info.mode & 0o777)) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt target permissions changed unexpectedly for '${relativePath}'`,
      );
    }

    try {
      await this.#git.commitExactTrackedFile(
        authorization,
        mode === "apply"
          ? `evolution: apply role-prompt ${relativePath} (${decision.actor})`
          : `evolution: rollback role-prompt ${relativePath} (${decision.actor})`,
      );
    } catch (error) {
      throw mapGitError(error);
    }

    clearPromptTemplateCache();
  }

  async #applyStrategyTarget(
    proposal: EvolutionProposal,
    before: TargetDigestState,
    after: TargetDigestState,
    _mode: "apply" | "rollback",
  ): Promise<void> {
    if (proposal.candidate.kind !== "strategy-blueprint") {
      throw new EvolutionApplicationError("POLICY_DENIED", "Not a strategy-blueprint candidate");
    }
    const name = proposal.candidate.name;
    // Configured (agent-team.yaml) strategies are never mutated. source() reports
    // "config" for names that are not present as custom blueprints; when a name is
    // both a baseline config name and somehow custom, customDefinition wins. Reject
    // when the name is a baseline-only configured strategy.
    const custom = this.#strategies.customDefinition(name);
    if (!custom && this.#strategies.source(name) === "config") {
      // source returns "config" for any non-custom name, including unknown names.
      // Unknown names are allowed for create. Detect baseline names via conflict on save.
      // Preflight: if resolve would find a config strategy and custom is absent, block
      // only when the catalog considers it a configured strategy (save throws CONFLICT).
      // We probe by checking whether the name exists in loaded config strategies.
      const configuredNames = new Set(
        Object.keys(this.#loaded.config.strategies?.definitions ?? {}),
      );
      if (configuredNames.has(name)) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          `Configured strategy '${name}' cannot be modified by evolution application`,
        );
      }
    }

    try {
      if (!after.present || after.strategyDefinition === null || after.strategyDefinition === undefined) {
        const current = this.#strategies.customDefinition(name);
        if (!current) {
          if (!before.present) {
            return;
          }
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Strategy blueprint '${name}' is absent but rollback expected a definition`,
          );
        }
        await this.#strategies.delete(name, {
          expectedBefore: before.strategyDefinition ?? current,
        });
        return;
      }

      const expectedBefore: StrategyBlueprintExpectedBefore = before.present
        ? (before.strategyDefinition ?? this.#strategies.customDefinition(name) ?? null)
        : null;
      await this.#strategies.save(name, after.strategyDefinition, { expectedBefore });
    } catch (error) {
      if (error instanceof EvolutionApplicationError) {
        throw error;
      }
      if (error instanceof StrategyBlueprintDriftError) {
        throw new EvolutionApplicationError("TARGET_DRIFTED", error.message);
      }
      if (error instanceof StrategyBlueprintConflictError) {
        throw new EvolutionApplicationError("POLICY_DENIED", error.message);
      }
      if (error instanceof StrategyBlueprintIndeterminateError) {
        throw new EvolutionApplicationError("RECOVERY_REQUIRED", error.message);
      }
      if (error instanceof StrategyBlueprintError) {
        throw new EvolutionApplicationError("POLICY_DENIED", error.message);
      }
      throw error;
    }
  }

  async #ingestPromptMaterial(contentDigest: string, content: Uint8Array): Promise<void> {
    if (typeof contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(contentDigest)) {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        "Role-prompt contentDigest must be a lowercase SHA-256 hex digest",
      );
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content);
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        "Role-prompt content must be valid UTF-8 text",
      );
    }
    if (bytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        `Role-prompt content exceeds ${EVOLUTION_PROMPT_MATERIAL_MAX_BYTES} bytes`,
      );
    }
    const actual = sha256Bytes(bytes);
    if (actual !== contentDigest) {
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        `Role-prompt content digest mismatch: expected ${contentDigest}, got ${actual}`,
      );
    }

    const objectPath = path.join(this.objectsDirectory, contentDigest);
    assertCanonicalInsideRoot(this.#catalog.root, objectPath, "Prompt object");
    await createDirectoryChain(this.#io, this.#catalog.root, this.objectsDirectory, 0o700);
    if ((await this.#io.realpath(this.objectsDirectory)) !== this.objectsDirectory) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Prompt object directory must not traverse symbolic links",
      );
    }

    try {
      const existingInfo = await this.#io.lstat(objectPath);
      if (existingInfo.isSymbolicLink() || !existingInfo.isFile()) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Prompt object path is not a regular file: ${objectPath}`,
        );
      }
      if (process.platform !== "win32" && (existingInfo.mode & 0o777) !== 0o600) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Prompt object permissions must be 0600: ${contentDigest}`,
        );
      }
      const existing = await this.#io.readFile(objectPath);
      if (sha256Bytes(existing) !== contentDigest) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Corrupted prompt object at ${contentDigest}`,
        );
      }
      // Idempotent re-ingest of identical object
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        if (error instanceof EvolutionApplicationError) throw error;
        throw error;
      }
    }

    const temporaryPath = `${objectPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = await this.#io.open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await this.#io.chmod(temporaryPath, 0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#io.rename(temporaryPath, objectPath);
      await this.#io.syncDirectory(this.objectsDirectory);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new EvolutionApplicationError(
        "MATERIAL_MISSING",
        `Failed to persist prompt object: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Post-condition
    const written = await this.#io.readFile(objectPath);
    if (sha256Bytes(written) !== contentDigest) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Prompt object digest mismatch after write for ${contentDigest}`,
      );
    }
  }

  async #readPromptObject(digest: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new EvolutionApplicationError("MATERIAL_MISSING", "Invalid prompt object digest");
    }
    const objectPath = path.join(this.objectsDirectory, digest);
    assertCanonicalInsideRoot(this.#catalog.root, objectPath, "Prompt object");
    try {
      if ((await this.#io.realpath(this.objectsDirectory)) !== this.objectsDirectory) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          "Prompt object directory must not traverse symbolic links",
        );
      }
      const info = await this.#io.lstat(objectPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object must be a regular non-symlink file: ${digest}`,
        );
      }
      if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object permissions must be 0600: ${digest}`,
        );
      }
      const bytes = await this.#io.readFile(objectPath);
      if (bytes.byteLength > EVOLUTION_PROMPT_MATERIAL_MAX_BYTES) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object exceeds size limit: ${digest}`,
        );
      }
      if (sha256Bytes(bytes) !== digest) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Corrupted prompt object: ${digest}`,
        );
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object is not valid UTF-8: ${digest}`,
        );
      }
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof EvolutionApplicationError) throw error;
      if (isNotFound(error)) {
        throw new EvolutionApplicationError(
          "MATERIAL_MISSING",
          `Prompt object not found: ${digest}`,
        );
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Gates
  // ---------------------------------------------------------------------------

  #requireProposal(proposalId: string): EvolutionProposal {
    const proposal = this.#catalog.getProposal(proposalId);
    if (!proposal) {
      throw new EvolutionApplicationError(
        "PROPOSAL_NOT_FOUND",
        `Proposal '${proposalId}' was not found`,
      );
    }
    return proposal;
  }

  #assertPromotable(proposal: EvolutionProposal): void {
    if (proposal.status !== "evaluated") {
      throw new EvolutionApplicationError(
        "INVALID_LIFECYCLE",
        `Proposal '${proposal.id}' must be evaluated before promote-and-apply (status=${proposal.status})`,
      );
    }
    if (!proposal.evaluation || proposal.evaluation.result.passed !== true) {
      throw new EvolutionApplicationError(
        "EVALUATION_NOT_PASSED",
        `Proposal '${proposal.id}' evaluation did not pass`,
      );
    }
  }

  #assertServerPreflightEvaluation(proposal: EvolutionProposal): void {
    if (proposal.evaluation?.source !== "server-structural-preflight-v1") {
      throw new EvolutionApplicationError(
        "EVALUATION_SOURCE_UNTRUSTED",
        `Proposal '${proposal.id}' was not evaluated by the current server preflight`,
      );
    }
  }

  #assertPolicyAllows(proposal: EvolutionProposal): void {
    const caps = proposal.policy.capabilities;
    if (
      caps.automaticExecution ||
      caps.automaticPromotion ||
      caps.networkPublication ||
      caps.secretStorage
    ) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        "Evolution policy capabilities forbid automatic execution/promotion, network publication, and secret storage",
      );
    }
  }

  #assertNoUnreconciledConflict(
    proposal: EvolutionProposal,
    _op: "promote" | "rollback",
  ): void {
    const target = targetFromCandidate(proposal.candidate);
    const activeId = this.#catalog.getActiveProposalId(target);
    if (activeId && activeId !== proposal.id && !this.#applications.has(activeId)) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Active promoted proposal '${activeId}' has no application proof; reconcilePromoted is required before replacement`,
      );
    }
  }

  async #assertQuiescentSafe(): Promise<void> {
    try {
      await this.#assertQuiescent();
    } catch (error) {
      throw new EvolutionApplicationError(
        "ACTIVE_RUN_CONFLICT",
        error instanceof Error ? error.message : "Project is not quiescent",
      );
    }
  }

  #assertOpen(): void {
    if (!this.#opened) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "EvolutionApplicationCoordinator is not open",
      );
    }
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (this.#recoveryRequired) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Application state requires recovery before further mutations",
      );
    }
    if (this.#pending) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "A pending application operation must be reconciled before further mutations",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence + open reconcile
  // ---------------------------------------------------------------------------

  async #loadOrInit(): Promise<void> {
    try {
      await assertSafeRegularFileOrMissing(
        this.#io,
        this.#catalog.root,
        this.applicationFilePath,
      );
      const text = await this.#io.readFile(this.applicationFilePath, "utf8");
      const restored = parseApplicationDocument(text, this.applicationFilePath);
      this.#persistedContents = text;
      this.#revision = restored.revision;
      this.#applications = new Map(
        restored.payload.applications.map((record) => [record.proposalId, record]),
      );
      this.#pending = restored.payload.pending;
      this.#completed = [...restored.payload.completed];
      this.#commands = new Map(
        restored.payload.commands.map((binding) => [binding.commandId, binding]),
      );
      this.#recoveryRequired = restored.payload.recoveryRequired;
      await this.#validateRestoredState();
    } catch (error) {
      if (isNotFound(error)) {
        this.#revision = 0;
        this.#applications = new Map();
        this.#pending = null;
        this.#completed = [];
        this.#commands = new Map();
        this.#recoveryRequired = false;
        this.#persistedContents = null;
        return;
      }
      throw error;
    }
  }

  async #validateRestoredState(): Promise<void> {
    const { revision, snapshot } = await this.#catalog.readSnapshot();
    const proposals = new Map(snapshot.proposals.map((proposal) => [proposal.id, proposal]));
    const activeByTarget = new Map(
      snapshot.activeProposals.map((pointer) => [targetKey(pointer.target), pointer.proposalId]),
    );
    const promotionByProposal = new Map(
      snapshot.auditRecords
        .filter((record): record is PromotionRecord => record.kind === "promotion")
        .map((record) => [record.proposalId, record]),
    );
    const completedByCommand = new Map(
      this.#completed.map((record) => [record.commandId, record]),
    );
    const syntheticCompletionIds = new Set<string>();
    const validateApplication = async (
      application: ApplicationRecord,
      parentCommandId: string | null = null,
    ): Promise<void> => {
      const proposal = proposals.get(application.proposalId);
      const completion = completedByCommand.get(application.commandId);
      const command = this.#commands.get(application.commandId);
      const expectedAfterTarget = proposal
        ? await this.#plannedAfterState(proposal, application.beforeTarget)
        : null;
      const reconcileMode = command?.previewTokenDigest.startsWith("reconcile:")
        ? command.previewTokenDigest.slice("reconcile:".length)
        : null;
      const reconcileRollbackSafe = reconcileMode === "apply" ||
        (command?.previewTokenDigest === "reconcile:adopt" && application.previousApplication !== null);
      const reconcileStatusMatches =
        (reconcileMode === "adopt" && application.status === "adopted") ||
        (reconcileMode === "apply" && application.status === "applied");
      const syntheticOwners: Array<{
        commandId: string;
        proposalId: string;
        reason: string;
        humanDecision: HumanDecision;
      }> = [];
      if (
        parentCommandId === this.#pending?.commandId &&
        this.#pending.operation === "reconcile-promoted"
      ) {
        syntheticOwners.push({
          commandId: this.#pending.commandId,
          proposalId: this.#pending.proposalId,
          reason: this.#pending.reason,
          humanDecision: this.#pending.humanDecision,
        });
      }
      for (const ownerCommand of this.#commands.values()) {
        if (
          ownerCommand.operation !== "reconcile-promoted" ||
          (parentCommandId !== null && ownerCommand.commandId !== parentCommandId)
        ) {
          continue;
        }
        const ownerCompletion = completedByCommand.get(ownerCommand.commandId);
        if (!ownerCompletion) continue;
        syntheticOwners.push({
          commandId: ownerCommand.commandId,
          proposalId: ownerCommand.proposalId,
          reason: ownerCommand.reason,
          humanDecision: ownerCompletion.humanDecision,
        });
      }
      const syntheticOwner = syntheticOwners.find((owner) => {
        const ownerPromotion = promotionByProposal.get(owner.proposalId);
        const expectedCommandId = `legacy:${sha256Canonical({
          commandId: owner.commandId,
          proposalId: application.proposalId,
          target: application.afterTarget,
        })}`;
        return (
          ownerPromotion?.previousActiveProposalId === application.proposalId &&
          expectedCommandId === application.commandId
        );
      });
      const syntheticLegacyBaseline =
        !command &&
        syntheticOwner !== undefined &&
        application.commandId.startsWith("legacy:") &&
        application.status === "adopted" &&
        application.previousApplication === null &&
        !application.rollbackSafe &&
        targetStatesEqual(application.beforeTarget, application.afterTarget) &&
        application.reason ===
          `Captured verified legacy predecessor while reconciling: ${syntheticOwner.reason}` &&
        completion !== undefined &&
        sha256Canonical(completion.humanDecision) ===
          sha256Canonical(syntheticOwner.humanDecision);
      if (syntheticLegacyBaseline) {
        syntheticCompletionIds.add(application.commandId);
      }
      if (
        !proposal ||
        !completion ||
        computeCandidateDigest(proposal.candidate) !== application.candidateDigest ||
        targetKey(targetFromCandidate(proposal.candidate)) !== targetKey(application.target) ||
        !expectedAfterTarget ||
        !targetStatesEqual(application.afterTarget, expectedAfterTarget) ||
        application.catalogRevision > revision ||
        completion.proposalId !== application.proposalId ||
        completion.candidateDigest !== application.candidateDigest ||
        completion.status !== application.status ||
        completion.beforeTargetDigest !== application.beforeTargetDigest ||
        completion.afterTargetDigest !== application.afterTargetDigest ||
        completion.catalogRevisionAfter !== application.catalogRevision ||
        completion.operator !== application.operator ||
        completion.reason !== application.reason ||
        completion.humanDecision.actor !== application.operator ||
        completion.humanDecision.decidedAt !== application.appliedAt ||
        (command
          ? command.operator !== application.operator ||
            command.reason !== application.reason ||
            command.result.applicationStatus !== application.status ||
            command.result.beforeTargetDigest !== application.beforeTargetDigest ||
            command.result.afterTargetDigest !== application.afterTargetDigest ||
            command.result.committedCatalogRevision !== application.catalogRevision
          : completion.catalogRevisionBefore !== application.catalogRevision) ||
        (completion.operation === "promote-and-apply" &&
          (!command ||
            command.operation !== "promote-and-apply" ||
            !application.rollbackSafe ||
            application.status !== "applied")) ||
        (completion.operation === "reconcile-promoted" &&
          (completion.status !== application.status ||
            (command
              ? command.operation !== "reconcile-promoted" ||
                !reconcileStatusMatches ||
                application.rollbackSafe !== reconcileRollbackSafe
              : !syntheticLegacyBaseline)))
      ) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: application proof for '${application.proposalId}' does not match the catalog`,
        );
      }
      if (application.previousApplication) {
        await validateApplication(application.previousApplication, application.commandId);
      }
    };
    for (const application of this.#applications.values()) {
      await validateApplication(application);
      const activeId = activeByTarget.get(targetKey(application.target));
      const committedPendingRollback =
        this.#pending?.operation === "rollback-applied" &&
        this.#pending.proposalId === application.proposalId &&
        revision === this.#pending.expectedCatalogRevisionAfter &&
        this.#catalogOutcomeMatchesPending(this.#pending, snapshot, revision);
      if (
        activeId !== application.proposalId &&
        (!activeId ||
          promotionByProposal.get(activeId)?.previousActiveProposalId !== application.proposalId) &&
        !committedPendingRollback
      ) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: '${application.proposalId}' is not the catalog active proposal`,
        );
      }
    }
    if (this.#pending) {
      const proposal = proposals.get(this.#pending.proposalId);
      const pendingTarget = proposal ? targetFromCandidate(proposal.candidate) : null;
      const activeId = pendingTarget ? activeByTarget.get(targetKey(pendingTarget)) ?? null : null;
      const expectedOldActive =
        this.#pending.operation === "promote-and-apply"
          ? this.#pending.previousActiveProposalId
          : this.#pending.proposalId;
      const expectedPreviousApplication =
        this.#pending.operation === "promote-and-apply"
          ? this.#pending.previousActiveProposalId
            ? (this.#applications.get(this.#pending.previousActiveProposalId) ?? null)
            : null
          : this.#pending.operation === "rollback-applied"
            ? (this.#applications.get(this.#pending.proposalId) ?? null)
            : this.#pending.previousApplication;
      let reconcileRestoredId: string | null | undefined;
      if (this.#pending.operation === "reconcile-promoted") {
        reconcileRestoredId = (
          await this.#catalog.preflightRollback(
            this.#pending.proposalId,
            this.#pending.humanDecision,
          )
        ).record.restoredActiveProposalId;
        if (this.#pending.previousApplication) {
          await validateApplication(
            this.#pending.previousApplication,
            this.#pending.commandId,
          );
        }
      }
      let expectedPendingBefore: TargetDigestState | null = null;
      let expectedPendingAfter: TargetDigestState | null = null;
      if (proposal) {
        if (
          this.#pending.operation === "rollback-applied" &&
          expectedPreviousApplication
        ) {
          expectedPendingBefore = expectedPreviousApplication.afterTarget;
          expectedPendingAfter = await this.#plannedRollbackState(
            proposal,
            expectedPreviousApplication,
          );
        } else {
          expectedPendingBefore = expectedPreviousApplication?.afterTarget ?? null;
          expectedPendingAfter = await this.#plannedAfterState(
            proposal,
            this.#pending.beforeTarget,
          );
        }
      }
      if (
        !proposal ||
        computeCandidateDigest(proposal.candidate) !== this.#pending.candidateDigest ||
        !pendingTarget ||
        !expectedPendingAfter ||
        !targetStatesEqual(this.#pending.afterTarget, expectedPendingAfter) ||
        (expectedPendingBefore !== null &&
          !targetStatesEqual(this.#pending.beforeTarget, expectedPendingBefore)) ||
        targetKey(pendingTarget) !== targetKeyFromState(this.#pending.beforeTarget) ||
        targetKey(pendingTarget) !== targetKeyFromState(this.#pending.afterTarget) ||
        (revision !== this.#pending.catalogRevisionBefore &&
          revision !== this.#pending.expectedCatalogRevisionAfter) ||
        (revision === this.#pending.catalogRevisionBefore && activeId !== expectedOldActive) ||
        sha256Canonical(this.#pending.previousApplication) !==
          sha256Canonical(expectedPreviousApplication) ||
        (this.#pending.operation === "reconcile-promoted" &&
          (this.#pending.previousApplication?.proposalId ?? null) !== reconcileRestoredId)
      ) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: pending operation '${this.#pending.commandId}' does not match the catalog`,
        );
      }
    }
    for (const completed of this.#completed) {
      const proposal = proposals.get(completed.proposalId);
      const expectedAuditKind =
        completed.operation === "promote-and-apply"
          ? "promotion"
          : completed.operation === "rollback-applied"
            ? "rollback"
            : null;
      const matchingAudit = expectedAuditKind
        ? snapshot.auditRecords.find(
            (record) =>
              record.kind === expectedAuditKind &&
              record.proposalId === completed.proposalId &&
              record.actor === completed.humanDecision.actor &&
              record.reason === completed.humanDecision.reason &&
              record.at === completed.humanDecision.decidedAt &&
              (record.applicationCommandId === completed.commandId ||
                (record.applicationCommandId === undefined &&
                  completed.status !== "aborted")),
          )
        : undefined;
      const catalogMutationSucceeded =
        completed.status === "applied" || completed.status === "rolled-back";
      const command = this.#commands.get(completed.commandId);
      if (
        !proposal ||
        computeCandidateDigest(proposal.candidate) !== completed.candidateDigest ||
        completed.catalogRevisionBefore > completed.catalogRevisionAfter ||
        completed.catalogRevisionAfter > revision ||
        (!command && !syntheticCompletionIds.has(completed.commandId)) ||
        (expectedAuditKind !== null && catalogMutationSucceeded !== Boolean(matchingAudit))
      ) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: completed operation '${completed.commandId}' does not match the catalog`,
        );
      }
    }
    for (const command of this.#commands.values()) {
      const completed = completedByCommand.get(command.commandId);
      const catalogProposal = proposals.get(command.proposalId);
      if (
        !completed ||
        completed.operation !== command.operation ||
        completed.proposalId !== command.proposalId ||
        !catalogProposal ||
        !proposalSnapshotMatchesCatalog(command.result.proposal, catalogProposal)
      ) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: command binding '${command.commandId}' has no matching completion`,
        );
      }
    }
    for (const audit of snapshot.auditRecords) {
      if (audit.kind === "rejection" || audit.applicationCommandId === undefined) continue;
      const completed = completedByCommand.get(audit.applicationCommandId);
      const pendingOwnsAudit =
        this.#pending?.commandId === audit.applicationCommandId &&
        this.#catalogOutcomeMatchesPending(this.#pending, snapshot, revision);
      if (
        !pendingOwnsAudit &&
        (!completed ||
          completed.proposalId !== audit.proposalId ||
          !["applied", "rolled-back"].includes(completed.status))
      ) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: catalog audit for command '${audit.applicationCommandId}' has no successful application result`,
        );
      }
    }
  }

  async #reconcilePendingOnOpen(): Promise<void> {
    const pending = this.#pending;
    if (!pending) {
      return;
    }

    const proposal = this.#catalog.getProposal(pending.proposalId);
    if (!proposal) {
      this.#recoveryRequired = true;
      return;
    }
    if (proposal.candidate.kind === "role-prompt") {
      await this.#cleanPendingPromptTemps(proposal.candidate.path);
    }

    let liveTarget: TargetDigestState;
    try {
      liveTarget = await this.#readTargetState(proposal.candidate);
    } catch {
      this.#recoveryRequired = true;
      return;
    }

    const { revision: catalogRevision, snapshot } = await this.#catalog.readSnapshot();
    const targetIsOld = targetStatesEqual(liveTarget, pending.beforeTarget);
    const targetIsNew = targetStatesEqual(liveTarget, pending.afterTarget);
    const catalogIsOld = catalogRevision === pending.catalogRevisionBefore;
    const catalogIsNew = this.#catalogOutcomeMatchesPending(pending, snapshot, catalogRevision);
    const promptGitApplied =
      proposal.candidate.kind === "role-prompt"
        ? await this.#verifyPromptGitOutcome(pending)
        : true;

    // old target + old catalog => aborted
    if (targetIsOld && catalogIsOld) {
      if (
        proposal.candidate.kind === "role-prompt" &&
        !(await this.#verifyPromptAbortOutcome(pending))
      ) {
        this.#recoveryRequired = true;
        return;
      }
      await this.#finalizePendingAs("aborted", catalogRevision, liveTarget.digest);
      return;
    }

    // new target + new catalog => finalize
    if (targetIsNew && catalogIsNew && promptGitApplied) {
      await this.#completePendingFromLive(pending, proposal, catalogRevision, liveTarget);
      return;
    }

    // new target + old catalog => idempotently finish catalog mutation
    if (targetIsNew && catalogIsOld) {
      try {
        if (proposal.candidate.kind === "role-prompt" && !promptGitApplied) {
          await this.#restoreInterruptedPrompt(proposal, pending.beforeTarget);
          await this.#finalizePendingAs(
            "aborted",
            catalogRevision,
            pending.beforeTarget.digest,
          );
          return;
        }
        if (pending.operation === "promote-and-apply") {
          if (proposal.status === "evaluated") {
            const evidence = proposal.evaluation?.evidence;
            if (!evidence) {
              this.#recoveryRequired = true;
              return;
            }
            await this.#catalog.promote(
              proposal.id,
              evidence,
              pending.humanDecision,
              this.#catalogWriter,
              pending.commandId,
            );
          } else if (proposal.status !== "promoted") {
            this.#recoveryRequired = true;
            return;
          }
        } else if (pending.operation === "rollback-applied") {
          if (proposal.status === "promoted") {
            await this.#catalog.rollback(
              proposal.id,
              pending.humanDecision,
              this.#catalogWriter,
              pending.commandId,
            );
          } else if (proposal.status !== "rolled-back") {
            this.#recoveryRequired = true;
            return;
          }
        } else if (pending.operation === "reconcile-promoted") {
          // Catalog already promoted; only application record needed
        } else {
          this.#recoveryRequired = true;
          return;
        }
        const finalProposal = this.#catalog.getProposal(pending.proposalId)!;
        await this.#completePendingFromLive(
          pending,
          finalProposal,
          this.#catalog.revision,
          liveTarget,
        );
        return;
      } catch {
        this.#recoveryRequired = true;
        return;
      }
    }

    // anything else => fail closed
    this.#recoveryRequired = true;
  }

  #catalogOutcomeMatchesPending(
    pending: PendingApplicationOperation,
    snapshot: EvolutionCatalogSnapshot,
    revision: number,
  ): boolean {
    if (revision !== pending.expectedCatalogRevisionAfter) return false;
    const proposal = snapshot.proposals.find((item) => item.id === pending.proposalId);
    if (!proposal) return false;
    const active = snapshot.activeProposals.find(
      (item) => targetKey(item.target) === targetKey(targetFromCandidate(proposal.candidate)),
    );
    if (pending.operation === "reconcile-promoted") {
      return proposal.status === "promoted" && active?.proposalId === proposal.id;
    }
    const audit = [...snapshot.auditRecords]
      .reverse()
      .find((record) => record.proposalId === pending.proposalId);
    if (!audit || sha256Canonical(audit) !== pending.expectedAuditDigest) return false;
    if (pending.operation === "promote-and-apply") {
      return proposal.status === "promoted" && active?.proposalId === proposal.id;
    }
    const rollback = audit as RollbackRecord;
    return (
      proposal.status === "rolled-back" &&
      (active?.proposalId ?? null) === rollback.restoredActiveProposalId
    );
  }

  async #verifyPromptGitOutcome(pending: PendingApplicationOperation): Promise<boolean> {
    if (!pending.gitBaseHead || !pending.gitPath) return false;
    const current = await this.#git.currentCommit(this.#catalog.root);
    if (current === pending.gitBaseHead) return false;
    let parent: string;
    try {
      parent = await this.#git.resolveCommit(`${current}^`);
    } catch {
      return false;
    }
    if (parent !== pending.gitBaseHead || !(await this.#git.isClean(this.#catalog.root))) {
      return false;
    }
    const diff = await this.#git.diffBetween(pending.gitBaseHead, current);
    return diff.changedFiles.length === 1 && diff.changedFiles[0] === pending.gitPath;
  }

  async #verifyPromptAbortOutcome(pending: PendingApplicationOperation): Promise<boolean> {
    if (!pending.gitBaseHead || !pending.gitPath) return false;
    return (
      (await this.#git.currentCommit(this.#catalog.root)) === pending.gitBaseHead &&
      (await this.#git.isClean(this.#catalog.root))
    );
  }

  async #restoreInterruptedPrompt(
    proposal: EvolutionProposal,
    before: TargetDigestState,
  ): Promise<void> {
    if (proposal.candidate.kind !== "role-prompt" || !before.digest || before.mode === undefined) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Interrupted prompt operation lacks a recoverable before snapshot",
      );
    }
    const bytes = await this.#readPromptObject(before.digest);
    const absolute = path.resolve(this.#catalog.root, proposal.candidate.path);
    const info = await this.#io.lstat(absolute);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      (await this.#io.realpath(absolute)) !== absolute
    ) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Interrupted prompt target is no longer a safe regular file",
      );
    }
    const directory = path.dirname(absolute);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(absolute)}.${process.pid}.${randomBytes(8).toString("hex")}.recovery.tmp`,
    );
    try {
      const handle = await this.#io.open(temporaryPath, "wx", before.mode);
      try {
        await handle.writeFile(bytes);
        await this.#io.chmod(temporaryPath, before.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#io.rename(temporaryPath, absolute);
      await this.#io.syncDirectory(directory);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    clearPromptTemplateCache();
    const restored = await this.#readTargetState(proposal.candidate);
    if (!targetStatesEqual(restored, before)) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Interrupted prompt recovery did not restore the complete target state",
      );
    }
    if (!(await this.#git.isClean(this.#catalog.root))) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Interrupted prompt was restored but the Git index/worktree is not clean",
      );
    }
  }

  async #cleanPendingPromptTemps(relativePath: string): Promise<void> {
    const absolute = path.resolve(this.#catalog.root, relativePath);
    const directory = path.dirname(absolute);
    if ((await this.#io.realpath(directory)) !== directory) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Pending prompt parent directory is unsafe",
      );
    }
    const escaped = escapeRegExp(path.basename(absolute));
    const pattern = new RegExp(
      `^\\.${escaped}\\.[0-9]+\\.[a-f0-9]{16}(?:\\.recovery)?\\.tmp$`,
    );
    for (const entry of await this.#io.readdir(directory)) {
      if (!pattern.test(entry)) continue;
      const candidate = path.join(directory, entry);
      const info = await this.#io.lstat(candidate).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) {
        await this.#io.rm(candidate, { force: true });
      }
    }
  }

  async #completePendingFromLive(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
    catalogRevision: number,
    liveTarget: TargetDigestState,
  ): Promise<void> {
    if (pending.operation === "promote-and-apply" || pending.operation === "reconcile-promoted") {
      if (
        pending.previousActiveProposalId &&
        pending.previousActiveProposalId !== pending.proposalId
      ) {
        this.#applications.delete(pending.previousActiveProposalId);
      }
      if (pending.operation === "reconcile-promoted" && pending.previousApplication) {
        this.#applications.delete(pending.previousApplication.proposalId);
      }
      this.#applications.set(pending.proposalId, {
        proposalId: pending.proposalId,
        candidateDigest: pending.candidateDigest,
        target: targetFromCandidate(proposal.candidate),
        status: "applied",
        beforeTargetDigest: pending.beforeTarget.digest,
        afterTargetDigest: liveTarget.digest!,
        beforeTarget: pending.beforeTarget,
        afterTarget: pending.afterTarget,
        previousApplication: pending.previousApplication,
        rollbackSafe: true,
        catalogRevision,
        operator: pending.operator,
        reason: pending.reason,
        appliedAt: pending.startedAt,
        commandId: pending.commandId,
      });
    } else if (pending.operation === "rollback-applied") {
      this.#applications.delete(pending.proposalId);
      const restoredId = pending.previousApplication?.previousApplication?.proposalId;
      const catalogRestoredId = this.#catalog.getActiveProposalId(
        targetFromCandidate(proposal.candidate),
      );
      if ((restoredId ?? null) !== catalogRestoredId) {
        this.#recoveryRequired = true;
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Recovered application predecessor does not match the catalog active pointer",
        );
      }
      if (restoredId) {
        this.#applications.set(restoredId, pending.previousApplication!.previousApplication!);
      }
    }

    const status: ApplicationStatus =
      pending.operation === "rollback-applied"
        ? "rolled-back"
        : pending.operation === "reconcile-promoted"
          ? "applied"
          : "applied";

    this.#completed.push({
      commandId: pending.commandId,
      operation: pending.operation,
      proposalId: pending.proposalId,
      candidateDigest: pending.candidateDigest,
      status,
      beforeTargetDigest: pending.beforeTarget.digest,
      afterTargetDigest: liveTarget.digest,
      catalogRevisionBefore: pending.catalogRevisionBefore,
      catalogRevisionAfter: catalogRevision,
      operator: pending.operator,
      reason: pending.reason,
      completedAt: new Date(this.#now()).toISOString(),
      humanDecision: pending.humanDecision,
    });

    if (!this.#commands.has(pending.commandId)) {
      this.#commands.set(pending.commandId, {
        commandId: pending.commandId,
        operation: pending.operation,
        proposalId: pending.proposalId,
        candidateDigest: pending.candidateDigest,
        operator: pending.operator,
        reason: pending.reason,
        expectedRevision: pending.catalogRevisionBefore,
        previewTokenDigest: pending.previewTokenDigest,
        requestDigest: pending.requestDigest,
        materialDigest: pending.materialDigest,
        result: {
          proposal: isolate(proposal),
          committedCatalogRevision: catalogRevision,
          applicationStatus: status,
          beforeTargetDigest: pending.beforeTarget.digest,
          afterTargetDigest: liveTarget.digest,
        },
      });
    }

    this.#pending = null;
    this.#recoveryRequired = false;
    await this.#persistApplicationState(this.#revision + 1);
  }

  async #finalizePendingAs(
    status: "aborted",
    catalogRevision: number,
    afterDigest: string | null,
  ): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    const syntheticPredecessorCommandId = pending.previousApplication?.commandId;
    if (
      pending.operation === "reconcile-promoted" &&
      syntheticPredecessorCommandId?.startsWith("legacy:") &&
      !this.#commands.has(syntheticPredecessorCommandId) &&
      ![...this.#applications.values()].some((application) =>
        applicationHistoryHasCommand(application, syntheticPredecessorCommandId),
      )
    ) {
      this.#completed = this.#completed.filter(
        (record) => record.commandId !== syntheticPredecessorCommandId,
      );
    }
    this.#completed.push({
      commandId: pending.commandId,
      operation: pending.operation,
      proposalId: pending.proposalId,
      candidateDigest: pending.candidateDigest,
      status,
      beforeTargetDigest: pending.beforeTarget.digest,
      afterTargetDigest: afterDigest,
      catalogRevisionBefore: pending.catalogRevisionBefore,
      catalogRevisionAfter: catalogRevision,
      operator: pending.operator,
      reason: pending.reason,
      completedAt: new Date(this.#now()).toISOString(),
      humanDecision: pending.humanDecision,
    });
    const proposal = this.#catalog.getProposal(pending.proposalId);
    if (proposal && !this.#commands.has(pending.commandId)) {
      this.#commands.set(pending.commandId, {
        commandId: pending.commandId,
        operation: pending.operation,
        proposalId: pending.proposalId,
        candidateDigest: pending.candidateDigest,
        operator: pending.operator,
        reason: pending.reason,
        expectedRevision: pending.catalogRevisionBefore,
        previewTokenDigest: pending.previewTokenDigest,
        requestDigest: pending.requestDigest,
        materialDigest: pending.materialDigest,
        result: {
          proposal,
          committedCatalogRevision: catalogRevision,
          applicationStatus: "aborted",
          beforeTargetDigest: pending.beforeTarget.digest,
          afterTargetDigest: afterDigest,
        },
      });
    }
    this.#pending = null;
    this.#recoveryRequired = false;
    await this.#persistApplicationState(this.#revision + 1);
  }

  async #persistApplicationState(nextRevision: number): Promise<void> {
    if (nextRevision !== this.#revision + 1) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Application state revision must advance by exactly one",
      );
    }
    const candidatePayload: ApplicationPayload = {
      applications: [...this.#applications.values()].sort((a, b) =>
        a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0,
      ),
      pending: this.#pending,
      completed: [...this.#completed],
      commands: [...this.#commands.values()].sort((a, b) =>
        a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0,
      ),
      recoveryRequired: this.#recoveryRequired,
    };
    const validatedPayload = applicationPayloadSchema.safeParse(candidatePayload);
    if (!validatedPayload.success) {
      this.#recoveryRequired = true;
      this.#opened = false;
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Refusing to persist invalid application state: ${validatedPayload.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const payload = isolate(validatedPayload.data) as ApplicationPayload;
    const document: ApplicationDocument = {
      version: EVOLUTION_APPLICATION_DOCUMENT_VERSION,
      revision: nextRevision,
      payloadDigest: computePayloadDigest(payload),
      payload,
    };
    const serialized = `${JSON.stringify(document)}\n`;
    const temporaryPath = `${this.applicationFilePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
      await assertSafeRegularFileOrMissing(
        this.#io,
        this.#catalog.root,
        this.applicationFilePath,
      );
      let diskContents: string | null;
      try {
        diskContents = await this.#io.readFile(this.applicationFilePath, "utf8");
      } catch (error) {
        if (!isNotFound(error)) throw error;
        diskContents = null;
      }
      if (diskContents !== this.#persistedContents) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Application state changed on disk; reopen before another mutation",
        );
      }
      const handle = await this.#io.open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await this.#io.chmod(temporaryPath, 0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#io.rename(temporaryPath, this.applicationFilePath);
      renamed = true;
      await this.#io.syncDirectory(this.evolutionDirectory);
      this.#revision = nextRevision;
      this.#persistedContents = serialized;
      this.#publishCommittedState();
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      this.#recoveryRequired = true;
      this.#opened = false;
      if (renamed) {
        this.#recoveryRequired = true;
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Application state rename completed but directory fsync failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Failed to persist application state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  #publishCommittedState(): void {
    this.#publishedState = isolate({
      revision: this.#revision,
      applications: [...this.#applications.values()].sort((a, b) =>
        a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0,
      ),
      pending: this.#pending,
      completed: [...this.#completed],
      recoveryRequired: this.#recoveryRequired,
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation).catch((error: unknown) => {
      throw mapToApplicationError(error);
    });
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serverPreflightItem(
  id: string,
  status: "pass" | "fail",
  summary: string,
): { kind: "deterministic"; id: string; status: "pass" | "fail"; summary: string } {
  return { kind: "deterministic", id, status, summary };
}

function toPublicPreview(preview: PreviewRecord): ApplicationPreview {
  const publicTarget = (
    target: TargetDigestState,
  ): Omit<TargetDigestState, "strategyDefinition"> => ({
    kind: target.kind,
    identity: target.identity,
    digest: target.digest,
    present: target.present,
    ...(target.mode === undefined ? {} : { mode: target.mode }),
  });
  return isolate({
    token: preview.token,
    kind: preview.kind,
    proposalId: preview.proposalId,
    candidateDigest: preview.candidateDigest,
    catalogRevision: preview.catalogRevision,
    activeProposalId: preview.activeProposalId,
    currentTargetDigest: preview.currentTargetDigest,
    operator: preview.operator,
    expiresAt: preview.expiresAt,
    beforeTarget: publicTarget(preview.beforeTarget),
    afterTarget: publicTarget(preview.afterTarget),
  });
}

function isolate<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function targetFromCandidate(candidate: EvolutionCandidate): EvolutionCandidateTarget {
  if (candidate.kind === "role-prompt") {
    return { kind: "role-prompt", path: candidate.path };
  }
  return { kind: "strategy-blueprint", name: candidate.name };
}

function targetKey(target: EvolutionCandidateTarget): string {
  return target.kind === "role-prompt"
    ? `role-prompt:${target.path}`
    : `strategy-blueprint:${target.name}`;
}

function applicationHistoryDepth(application: ApplicationRecord): number {
  let depth = 0;
  let current: ApplicationRecord | null = application;
  while (current) {
    depth += 1;
    if (depth > MAX_APPLICATION_HISTORY_DEPTH) return depth;
    current = current.previousApplication;
  }
  return depth;
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvolutionApplicationError("POLICY_DENIED", `${label} is required`);
  }
  return value.trim();
}

function requireCommandId(commandId: string): string {
  if (
    typeof commandId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(commandId)
  ) {
    throw new EvolutionApplicationError(
      "POLICY_DENIED",
      "commandId must be 1-128 characters of letters, numbers, and ._: -",
    );
  }
  return commandId;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function targetStatesEqual(left: TargetDigestState, right: TargetDigestState): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
}

function proposalSnapshotMatchesCatalog(
  historical: EvolutionProposal,
  current: EvolutionProposal,
): boolean {
  if (
    sha256Canonical({
      id: historical.id,
      createdAt: historical.createdAt,
      policy: historical.policy,
      candidate: historical.candidate,
      evaluation: historical.evaluation ?? null,
    }) !==
      sha256Canonical({
        id: current.id,
        createdAt: current.createdAt,
        policy: current.policy,
        candidate: current.candidate,
        evaluation: current.evaluation ?? null,
      }) ||
    historical.transitions.length > current.transitions.length ||
    historical.transitions.some(
      (transition, index) =>
        sha256Canonical(transition) !== sha256Canonical(current.transitions[index]),
    ) ||
    (historical.promotionRecordDigest !== undefined &&
      historical.promotionRecordDigest !== current.promotionRecordDigest)
  ) {
    return false;
  }
  return true;
}

function applicationHistoryHasCommand(
  application: ApplicationRecord,
  commandId: string,
): boolean {
  let current: ApplicationRecord | null = application;
  while (current) {
    if (current.commandId === commandId) return true;
    current = current.previousApplication;
  }
  return false;
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

function mapGitError(error: unknown): EvolutionApplicationError {
  if (error instanceof GitManagerError) {
    if (error.code === "GIT_WORKTREE_CONTAMINATED" || error.code === "GIT_HEAD_DRIFT") {
      return new EvolutionApplicationError("TARGET_DRIFTED", error.message);
    }
    if (error.code === "GIT_TARGET_NOT_TRACKED" || error.code === "GIT_UNSAFE_PATH") {
      return new EvolutionApplicationError("POLICY_DENIED", error.message);
    }
    return new EvolutionApplicationError("RECOVERY_REQUIRED", error.message);
  }
  return mapToApplicationError(error);
}

function mapToApplicationError(
  error: unknown,
  fallback: EvolutionApplicationErrorCode = "RECOVERY_REQUIRED",
): EvolutionApplicationError {
  if (error instanceof EvolutionApplicationError) {
    return error;
  }
  if (error instanceof EvolutionPersistenceError) {
    return new EvolutionApplicationError(fallback, error.message);
  }
  if (error instanceof EvolutionCatalogNotFoundError) {
    return new EvolutionApplicationError("PROPOSAL_NOT_FOUND", error.message);
  }
  if (error instanceof EvolutionCatalogConflictError) {
    return new EvolutionApplicationError("ACTIVE_TARGET_CONFLICT", error.message);
  }
  if (error instanceof EvolutionLifecycleError) {
    return new EvolutionApplicationError("INVALID_LIFECYCLE", error.message);
  }
  if (error instanceof EvolutionPromotionError) {
    return new EvolutionApplicationError("EVALUATION_NOT_PASSED", error.message);
  }
  if (error instanceof EvolutionValidationError || error instanceof EvolutionDomainError) {
    return new EvolutionApplicationError("POLICY_DENIED", error.message);
  }
  return new EvolutionApplicationError(
    fallback,
    error instanceof Error ? error.message : String(error),
  );
}

function parseApplicationDocument(
  text: string,
  filePath: string,
): { revision: number; payload: ApplicationPayload } {
  if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: document exceeds 16 MiB`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: malformed JSON`,
    );
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: expected object document`,
    );
  }
  const record = document as Record<string, unknown>;
  assertExactKeys(
    record,
    ["version", "revision", "payloadDigest", "payload"],
    `application state at ${filePath}`,
  );
  if (record.version !== EVOLUTION_APPLICATION_DOCUMENT_VERSION) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: unsupported version`,
    );
  }
  if (
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: revision must be a positive safe integer`,
    );
  }
  if (typeof record.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.payloadDigest)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: payloadDigest must be lowercase SHA-256 hex`,
    );
  }
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: payload must be an object`,
    );
  }
  const payloadRecord = record.payload as Record<string, unknown>;
  assertExactKeys(
    payloadRecord,
    ["applications", "pending", "completed", "commands", "recoveryRequired"],
    `application state payload at ${filePath}`,
  );
  assertJsonNestingDepth(payloadRecord, filePath);
  assertRawApplicationHistoryDepth(payloadRecord, filePath);
  const expectedDigest = computePayloadDigest(payloadRecord);
  if (expectedDigest !== record.payloadDigest) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: payload digest mismatch`,
    );
  }
  const parsedPayload = applicationPayloadSchema.safeParse(payloadRecord);
  if (!parsedPayload.success) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: ${parsedPayload.error.issues
        .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  assertUniqueBy(
    parsedPayload.data.applications,
    (item) => item.proposalId,
    "application proposalId",
    filePath,
  );
  assertUniqueBy(
    parsedPayload.data.applications,
    (item) => targetKey(item.target),
    "active application target",
    filePath,
  );
  assertUniqueBy(
    parsedPayload.data.completed,
    (item) => item.commandId,
    "completed commandId",
    filePath,
  );
  assertUniqueBy(
    parsedPayload.data.commands,
    (item) => item.commandId,
    "idempotency commandId",
    filePath,
  );
  for (const application of parsedPayload.data.applications) {
    validateApplicationRecord(application, filePath);
  }
  for (const command of parsedPayload.data.commands) {
    const completed = parsedPayload.data.completed.find(
      (record) => record.commandId === command.commandId,
    );
    if (
      command.result.proposal.id !== command.proposalId ||
      computeCandidateDigest(command.result.proposal.candidate) !== command.candidateDigest ||
      !completed ||
      completed.operation !== command.operation ||
      completed.proposalId !== command.proposalId ||
      completed.candidateDigest !== command.candidateDigest ||
      completed.operator !== command.operator ||
      completed.reason !== command.reason ||
      completed.catalogRevisionBefore !== command.expectedRevision ||
      completed.catalogRevisionAfter !== command.result.committedCatalogRevision ||
      completed.status !== command.result.applicationStatus ||
      completed.beforeTargetDigest !== command.result.beforeTargetDigest ||
      completed.afterTargetDigest !== command.result.afterTargetDigest ||
      completed.humanDecision.actor !== command.operator ||
      completed.humanDecision.reason !== command.reason
    ) {
      throw new EvolutionPersistenceValidationError(
        `Invalid application state at ${filePath}: command '${command.commandId}' result binding mismatch`,
      );
    }
  }
  const pending = parsedPayload.data.pending;
  if (
    pending &&
    (parsedPayload.data.commands.some((item) => item.commandId === pending.commandId) ||
      parsedPayload.data.completed.some((item) => item.commandId === pending.commandId))
  ) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: pending commandId is already completed`,
    );
  }

  return {
    revision: record.revision,
    payload: isolate(parsedPayload.data) as ApplicationPayload,
  };
}

function assertJsonNestingDepth(value: unknown, filePath: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (current.depth > 256) {
      throw new EvolutionPersistenceValidationError(
        `Invalid application state at ${filePath}: JSON nesting is too deep`,
      );
    }
    for (const child of Object.values(current.value as Record<string, unknown>)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function assertRawApplicationHistoryDepth(
  payload: Record<string, unknown>,
  filePath: string,
): void {
  const roots: unknown[] = Array.isArray(payload.applications)
    ? [...payload.applications]
    : [];
  if (payload.pending && typeof payload.pending === "object" && !Array.isArray(payload.pending)) {
    roots.push((payload.pending as Record<string, unknown>).previousApplication);
  }
  for (const root of roots) {
    let current = root;
    let depth = 0;
    while (current && typeof current === "object" && !Array.isArray(current)) {
      depth += 1;
      if (depth > MAX_APPLICATION_HISTORY_DEPTH) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state at ${filePath}: application history is too deep`,
        );
      }
      current = (current as Record<string, unknown>).previousApplication;
    }
  }
}

function assertUniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
  filePath: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      throw new EvolutionPersistenceValidationError(
        `Invalid application state at ${filePath}: duplicate ${label} '${key}'`,
      );
    }
    seen.add(key);
  }
}

function validateApplicationRecord(
  application: ApplicationRecord,
  filePath: string,
  depth = 0,
): void {
  if (depth >= MAX_APPLICATION_HISTORY_DEPTH) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: application history is too deep`,
    );
  }
  if (
    application.beforeTargetDigest !== application.beforeTarget.digest ||
    application.afterTargetDigest !== application.afterTarget.digest ||
    targetKey(application.target) !== targetKeyFromState(application.afterTarget) ||
    targetKeyFromState(application.beforeTarget) !== targetKey(application.target)
  ) {
    throw new EvolutionPersistenceValidationError(
      `Invalid application state at ${filePath}: application '${application.proposalId}' target binding mismatch`,
    );
  }
  if (application.previousApplication) {
    if (
      targetKey(application.previousApplication.target) !== targetKey(application.target) ||
      application.previousApplication.afterTargetDigest !== application.beforeTargetDigest
    ) {
      throw new EvolutionPersistenceValidationError(
        `Invalid application state at ${filePath}: application '${application.proposalId}' history mismatch`,
      );
    }
    validateApplicationRecord(application.previousApplication, filePath, depth + 1);
  }
}

function targetKeyFromState(state: TargetDigestState): string {
  return state.kind === "role-prompt"
    ? `role-prompt:${state.identity}`
    : `strategy-blueprint:${state.identity}`;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  const unexpected = actual.find((key) => !expected.has(key));
  const missing = expectedKeys.find((key) => !Object.hasOwn(record, key));
  if (unexpected || missing || actual.length !== expected.size) {
    throw new EvolutionPersistenceValidationError(
      `Invalid ${label}: expected exactly fields ${expectedKeys.join(", ")}${
        unexpected ? `; unexpected field '${unexpected}'` : ""
      }${missing ? `; missing field '${missing}'` : ""}`,
    );
  }
}

async function createDirectoryChain(
  io: EvolutionApplicationFileIo,
  root: string,
  target: string,
  mode: number,
): Promise<void> {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new EvolutionPersistenceValidationError(
      `Path must remain below repository root: ${target}`,
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await io.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new EvolutionPersistenceValidationError(
          `Path component must be a real directory: ${current}`,
        );
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await io.mkdir(current, { mode });
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await io.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new EvolutionPersistenceValidationError(
          `Path component must be a real directory: ${current}`,
        );
      }
    }
  }
}

async function assertSafeRegularFileOrMissing(
  io: EvolutionApplicationFileIo,
  root: string,
  filePath: string,
): Promise<void> {
  try {
    const info = await io.lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new EvolutionPersistenceValidationError(
        `Application state must be a regular non-symlink file: ${filePath}`,
      );
    }
    if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      throw new EvolutionPersistenceValidationError(
        `Application state permissions must be 0600: ${filePath}`,
      );
    }
    const canonical = await io.realpath(filePath);
    assertCanonicalInsideRoot(root, canonical, "Application state");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function cleanOrphanTemps(
  io: EvolutionApplicationFileIo,
  directory: string,
  basename: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await io.readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const pattern = new RegExp(
    `^${escapeRegExp(basename)}\\.[0-9]+\\.[a-f0-9]{16}\\.tmp$`,
  );
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const absolute = path.join(directory, entry);
    try {
      const info = await io.lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      await io.rm(absolute, { force: true });
    } catch {
      // best-effort
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertCanonicalInsideRoot(root: string, candidate: string, label: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(rootPrefix)) {
    throw new EvolutionPersistenceValidationError(
      `${label} resolves outside repository root: ${candidate}`,
    );
  }
}

async function defaultSyncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof openAsync>> | undefined;
  try {
    handle = await openAsync(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (
      process.platform === "win32" &&
      (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
