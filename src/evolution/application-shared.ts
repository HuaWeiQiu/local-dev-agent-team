import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NamedStrategy } from "../config/schema.js";
import { GitManagerError } from "../git/manager.js";
import {
  EvolutionCatalogConflictError,
  EvolutionCatalogNotFoundError,
  type EvolutionCandidateTarget,
} from "./catalog.js";
import {
  EvolutionDomainError,
  EvolutionLifecycleError,
  EvolutionPromotionError,
  EvolutionValidationError,
  type EvolutionCandidate,
  type EvolutionProposal,
  type HumanDecision,
} from "./domain.js";
import {
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
export const MAX_APPLICATION_HISTORY_DEPTH = 100;

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

export type ApplicationPayload = {
  readonly applications: readonly ApplicationRecord[];
  readonly pending: PendingApplicationOperation | null;
  readonly completed: readonly CompletedApplicationRecord[];
  readonly commands: readonly CommandIdempotencyBinding[];
  readonly recoveryRequired: boolean;
};

export type ApplicationDocument = {
  readonly version: typeof EVOLUTION_APPLICATION_DOCUMENT_VERSION;
  readonly revision: number;
  readonly payloadDigest: string;
  readonly payload: ApplicationPayload;
};

export type EvolutionApplicationFileIo = DurableEvolutionFileIo & {
  writeFile: typeof writeFile;
  chmod: typeof chmod;
};

/**
 * Mutable coordinator internals shared with the journal, preview, and target
 * units. Owned by the coordinator; every mutation still happens on its serial
 * command queue.
 */
export interface EvolutionApplicationState {
  revision: number;
  applications: Map<string, ApplicationRecord>;
  pending: PendingApplicationOperation | null;
  completed: CompletedApplicationRecord[];
  commands: Map<string, CommandIdempotencyBinding>;
  recoveryRequired: boolean;
  opened: boolean;
  persistedContents: string | null;
  publishedState: ApplicationStateSnapshot;
  catalogWriter: object | undefined;
}

export function isolate<T>(value: T): T {
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

export function targetFromCandidate(candidate: EvolutionCandidate): EvolutionCandidateTarget {
  if (candidate.kind === "role-prompt") {
    return { kind: "role-prompt", path: candidate.path };
  }
  return { kind: "strategy-blueprint", name: candidate.name };
}

export function targetKey(target: EvolutionCandidateTarget): string {
  return target.kind === "role-prompt"
    ? `role-prompt:${target.path}`
    : `strategy-blueprint:${target.name}`;
}

export function targetKeyFromState(state: TargetDigestState): string {
  return state.kind === "role-prompt"
    ? `role-prompt:${state.identity}`
    : `strategy-blueprint:${state.identity}`;
}

export function applicationHistoryDepth(application: ApplicationRecord): number {
  let depth = 0;
  let current: ApplicationRecord | null = application;
  while (current) {
    depth += 1;
    if (depth > MAX_APPLICATION_HISTORY_DEPTH) return depth;
    current = current.previousApplication;
  }
  return depth;
}

export function applicationHistoryHasCommand(
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

export function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvolutionApplicationError("POLICY_DENIED", `${label} is required`);
  }
  return value.trim();
}

export function requireCommandId(commandId: string): string {
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

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function targetStatesEqual(left: TargetDigestState, right: TargetDigestState): boolean {
  return sha256Canonical(left) === sha256Canonical(right);
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

export function mapGitError(error: unknown): EvolutionApplicationError {
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

export function mapToApplicationError(
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertCanonicalInsideRoot(root: string, candidate: string, label: string): void {
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

export function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
