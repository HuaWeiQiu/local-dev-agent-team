import {
  createEvolutionProposal,
  evaluateProposal,
  EvolutionDomainError,
  EvolutionValidationError,
  promoteProposal,
  rejectProposal,
  rollbackProposal,
  transitionProposal,
  type AuditRecord,
  type EvolutionCandidate,
  type EvolutionProposal,
  type EvolutionTrustContext,
  type PromotionRecord,
  type RejectionRecord,
  type RollbackRecord,
} from "./domain.js";

/** Phase-1 in-memory evolution catalog document version. */
export const EVOLUTION_CATALOG_VERSION = 1 as const;

export class EvolutionCatalogError extends EvolutionDomainError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionCatalogError";
  }
}

export class EvolutionCatalogNotFoundError extends EvolutionCatalogError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionCatalogNotFoundError";
  }
}

export class EvolutionCatalogConflictError extends EvolutionCatalogError {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionCatalogConflictError";
  }
}

/**
 * Stable identity of a catalog candidate target.
 * Active proposal pointers are tracked per target, not per proposal.
 */
export type EvolutionCandidateTarget =
  | { readonly kind: "strategy-blueprint"; readonly name: string }
  | { readonly kind: "role-prompt"; readonly path: string };

export type EvolutionActiveProposalPointer = {
  readonly target: EvolutionCandidateTarget;
  readonly proposalId: string;
};

/**
 * Immutable, deeply isolated catalog snapshot.
 * Arrays use stable deterministic ordering suitable for equality checks.
 */
export type EvolutionCatalogSnapshot = {
  readonly version: typeof EVOLUTION_CATALOG_VERSION;
  readonly proposals: readonly EvolutionProposal[];
  readonly auditRecords: readonly AuditRecord[];
  readonly activeProposals: readonly EvolutionActiveProposalPointer[];
};

type MutableCatalogState = {
  proposals: Map<string, EvolutionProposal>;
  auditRecords: AuditRecord[];
  activeByTarget: Map<string, string>;
  promotionRecords: Map<string, PromotionRecord>;
};

/**
 * Pure, authoritative in-memory evolution catalog.
 *
 * Lifecycle validation and transitions are delegated exclusively to
 * {@link ./domain.js}. This catalog owns proposal indexes, audit history,
 * per-target active pointers, and internal promotion provenance used for
 * rollback. It does not persist state, mutate source files, execute agents,
 * open network connections, or auto-promote.
 */
export class EvolutionCatalog {
  #proposals = new Map<string, EvolutionProposal>();
  #auditRecords: AuditRecord[] = [];
  #activeByTarget = new Map<string, string>();
  /** Internally retained promotion provenance; never accepted from callers. */
  #promotionRecords = new Map<string, PromotionRecord>();
  #trust: EvolutionTrustContext;
  #mutating = false;

  constructor(trust: EvolutionTrustContext) {
    this.#trust = snapshotTrustContext(trust);
  }

  /**
   * Create and store a new proposal in `proposed` status.
   * Proposal IDs are globally unique within this catalog instance.
   */
  propose(input: {
    id: string;
    createdAt: string;
    policy: unknown;
    candidate: unknown;
  }): EvolutionProposal {
    return this.#runMutation(() => {
      let proposal: EvolutionProposal;
      try {
        proposal = createEvolutionProposal({
          id: input.id,
          createdAt: input.createdAt,
          policy: input.policy,
          candidate: input.candidate,
          trust: this.#trust,
        });
      } catch (error) {
        // Domain schema parse may surface ZodError for invalid proposal ids;
        // normalize to the domain validation error type for callers.
        if (error instanceof EvolutionDomainError) {
          throw error;
        }
        const message =
          error instanceof Error ? error.message : "Invalid evolution proposal input";
        throw new EvolutionValidationError(message);
      }

      // Uniqueness must use the domain-normalized id (trimmed), not the raw input.
      if (this.#proposals.has(proposal.id)) {
        throw new EvolutionCatalogConflictError(
          `Proposal id '${proposal.id}' is already present in the catalog`,
        );
      }

      return this.#commit((state) => {
        state.proposals.set(proposal.id, proposal);
        return isolate(proposal);
      });
    });
  }

  /** Transition a stored proposal from `proposed` to `evaluating`. */
  beginEvaluation(proposalId: string, at: string): EvolutionProposal {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const next = transitionProposal(current, "evaluating", at);
      return this.#commit((state) => {
        state.proposals.set(next.id, next);
        return isolate(next);
      });
    });
  }

  /**
   * Attach evaluation evidence and transition `evaluating` → `evaluated`.
   * Failed deterministic or advisory evidence is recorded; promotion remains gated.
   */
  evaluate(proposalId: string, evidence: unknown, at: string): EvolutionProposal {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const next = evaluateProposal(current, evidence, at);
      return this.#commit((state) => {
        state.proposals.set(next.id, next);
        return isolate(next);
      });
    });
  }

  /**
   * Human-gated promotion. Binds the previous active proposal for the same
   * candidate target and retains the promotion record for later rollback.
   */
  promote(
    proposalId: string,
    evidence: unknown,
    decision: unknown,
  ): { proposal: EvolutionProposal; record: PromotionRecord } {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const targetKey = candidateTargetKey(current.candidate);
      const previousActiveProposalId = this.#activeByTarget.get(targetKey) ?? null;

      const { proposal, record } = promoteProposal({
        proposal: current,
        evidence,
        decision,
        previousActiveProposalId,
      });

      return this.#commit((state) => {
        state.proposals.set(proposal.id, proposal);
        state.auditRecords.push(record);
        state.promotionRecords.set(proposal.id, record);
        state.activeByTarget.set(targetKey, proposal.id);
        return {
          proposal: isolate(proposal),
          record: isolate(record),
        };
      });
    });
  }

  /** Human-gated rejection of an evaluated proposal. */
  reject(
    proposalId: string,
    decision: unknown,
  ): { proposal: EvolutionProposal; record: RejectionRecord } {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const { proposal, record } = rejectProposal({
        proposal: current,
        decision,
      });

      return this.#commit((state) => {
        state.proposals.set(proposal.id, proposal);
        state.auditRecords.push(record);
        return {
          proposal: isolate(proposal),
          record: isolate(record),
        };
      });
    });
  }

  /**
   * Human-gated rollback of a promoted proposal.
   * Restoration is derived only from the internally retained promotion record;
   * callers cannot supply or substitute provenance.
   */
  rollback(
    proposalId: string,
    decision: unknown,
  ): { proposal: EvolutionProposal; record: RollbackRecord } {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const promotionRecord = this.#promotionRecords.get(proposalId);
      if (!promotionRecord && current.status === "promoted") {
        throw new EvolutionCatalogError(
          `Proposal '${proposalId}' has no internally retained promotion record for rollback`,
        );
      }

      // The pure domain operation performs lifecycle and provenance validation first.
      const { proposal, record } = rollbackProposal({
        proposal: current,
        promotionRecord,
        decision,
      });

      const targetKey = candidateTargetKey(current.candidate);
      // Only the currently active proposal for a target may be rolled back. This
      // prevents inactive promotions from corrupting a later restoration chain.
      if (this.#activeByTarget.get(targetKey) !== current.id) {
        throw new EvolutionCatalogConflictError(
          `Proposal '${proposalId}' is not the active proposal for its candidate target and cannot be rolled back`,
        );
      }

      return this.#commit((state) => {
        state.proposals.set(proposal.id, proposal);
        state.auditRecords.push(record);

        if (record.restoredActiveProposalId === null) {
          state.activeByTarget.delete(targetKey);
        } else {
          state.activeByTarget.set(targetKey, record.restoredActiveProposalId);
        }

        return {
          proposal: isolate(proposal),
          record: isolate(record),
        };
      });
    });
  }

  /** Return an isolated copy of a stored proposal, if present. */
  getProposal(proposalId: string): EvolutionProposal | undefined {
    const proposal = this.#proposals.get(proposalId);
    return proposal === undefined ? undefined : isolate(proposal);
  }

  /** Return the active proposal id for a candidate target, if any. */
  getActiveProposalId(target: EvolutionCandidateTarget): string | null {
    return this.#activeByTarget.get(candidateTargetKeyFromTarget(target)) ?? null;
  }

  /**
   * Return an immutable, deeply isolated snapshot with deterministic ordering.
   * Mutations to the returned value cannot affect catalog state.
   */
  snapshot(): EvolutionCatalogSnapshot {
    const proposals = [...this.#proposals.values()]
      .map((proposal) => isolate(proposal))
      .sort(compareProposals);

    const auditRecords = this.#auditRecords
      .map((record) => isolate(record))
      .sort(compareAuditRecords);

    const activeProposals = [...this.#activeByTarget.entries()]
      .map(([key, proposalId]) => ({
        target: targetFromKey(key),
        proposalId,
      }))
      .sort((left, right) =>
        compareCodeUnits(
          candidateTargetKeyFromTarget(left.target),
          candidateTargetKeyFromTarget(right.target),
        ),
      );

    return deepFreeze({
      version: EVOLUTION_CATALOG_VERSION,
      proposals,
      auditRecords,
      activeProposals,
    });
  }

  #requireProposal(proposalId: string): EvolutionProposal {
    const proposal = this.#proposals.get(proposalId);
    if (!proposal) {
      throw new EvolutionCatalogNotFoundError(
        `Proposal '${proposalId}' was not found in the catalog`,
      );
    }
    return proposal;
  }

  /**
   * Apply a mutation against a cloned working copy, then commit only after
   * the mutator returns successfully. Domain failures leave catalog state intact.
   */
  #commit<T>(mutator: (state: MutableCatalogState) => T): T {
    const working: MutableCatalogState = {
      proposals: new Map(this.#proposals),
      auditRecords: [...this.#auditRecords],
      activeByTarget: new Map(this.#activeByTarget),
      promotionRecords: new Map(this.#promotionRecords),
    };

    const result = mutator(working);

    this.#proposals = working.proposals;
    this.#auditRecords = working.auditRecords;
    this.#activeByTarget = working.activeByTarget;
    this.#promotionRecords = working.promotionRecords;

    return result;
  }

  #runMutation<T>(operation: () => T): T {
    if (this.#mutating) {
      throw new EvolutionCatalogConflictError("A catalog mutation is already in progress");
    }
    this.#mutating = true;
    try {
      return operation();
    } finally {
      this.#mutating = false;
    }
  }
}

export function createEvolutionCatalog(trust: EvolutionTrustContext): EvolutionCatalog {
  return new EvolutionCatalog(trust);
}

function snapshotTrustContext(trust: EvolutionTrustContext): EvolutionTrustContext {
  if (
    !trust ||
    !Array.isArray(trust.configuredRolePromptPaths) ||
    !trust.roleAllowedProfiles ||
    typeof trust.roleAllowedProfiles !== "object" ||
    Array.isArray(trust.roleAllowedProfiles)
  ) {
    throw new EvolutionValidationError("trust: A valid EvolutionTrustContext is required");
  }

  const configuredRolePromptPaths = trust.configuredRolePromptPaths.map((path) => {
    if (typeof path !== "string") {
      throw new EvolutionValidationError("trust.configuredRolePromptPaths must contain strings");
    }
    return path;
  });
  const roleAllowedProfiles = Object.create(null) as Record<string, readonly string[]>;
  for (const [role, profiles] of Object.entries(trust.roleAllowedProfiles)) {
    if (!Array.isArray(profiles) || profiles.some((profile) => typeof profile !== "string")) {
      throw new EvolutionValidationError(
        `trust.roleAllowedProfiles.${role} must contain profile-name strings`,
      );
    }
    roleAllowedProfiles[role] = [...profiles];
  }

  return deepFreeze({ configuredRolePromptPaths, roleAllowedProfiles });
}

function candidateTargetKey(candidate: EvolutionCandidate): string {
  if (candidate.kind === "strategy-blueprint") {
    return `strategy-blueprint:${candidate.name}`;
  }
  return `role-prompt:${candidate.path}`;
}

function candidateTargetKeyFromTarget(target: EvolutionCandidateTarget): string {
  if (target.kind === "strategy-blueprint") {
    return `strategy-blueprint:${target.name}`;
  }
  return `role-prompt:${target.path}`;
}

function targetFromKey(key: string): EvolutionCandidateTarget {
  const separator = key.indexOf(":");
  if (separator <= 0) {
    throw new EvolutionCatalogError(`Invalid candidate target key '${key}'`);
  }
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (kind === "strategy-blueprint") {
    return { kind: "strategy-blueprint", name: value };
  }
  if (kind === "role-prompt") {
    return { kind: "role-prompt", path: value };
  }
  throw new EvolutionCatalogError(`Unknown candidate target kind in key '${key}'`);
}

function compareProposals(left: EvolutionProposal, right: EvolutionProposal): number {
  return compareCodeUnits(left.id, right.id);
}

function compareAuditRecords(left: AuditRecord, right: AuditRecord): number {
  const byAt = compareCodeUnits(left.at, right.at);
  if (byAt !== 0) {
    return byAt;
  }
  const byKind = compareCodeUnits(left.kind, right.kind);
  if (byKind !== 0) {
    return byKind;
  }
  return compareCodeUnits(left.proposalId, right.proposalId);
}

/** Locale-independent lexicographic comparison by UTF-16 code units. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isolate<T>(value: T): T {
  return deepFreeze(structuredClone(value));
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
