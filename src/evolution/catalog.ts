import { auditTrailViolation } from "./audit-trail.js";
import {
  archiveProposal,
  assertPromotionRecordMatchesProposal,
  auditRecordSchema,
  createEvolutionProposal,
  deleteProposal,
  evaluateProposal,
  EvolutionDomainError,
  EvolutionValidationError,
  parseEvolutionProposal,
  parsePromotionRecord,
  promoteProposal,
  rejectProposal,
  rollbackProposal,
  transitionProposal,
  unarchiveProposal,
  type ArchiveRecord,
  type AuditRecord,
  type DeletionRecord,
  type EvolutionCandidate,
  type EvolutionEvaluationSource,
  type EvolutionProposal,
  type EvolutionTrustContext,
  type PromotionRecord,
  type RejectionRecord,
  type RollbackRecord,
  type UnarchiveRecord,
} from "./domain.js";

/** In-memory evolution catalog snapshot version. */
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
 * rollback. It does not open the network, mutate source files, execute agents,
 * or auto-promote. Filesystem durability is owned by the Phase-2 asynchronous
 * wrapper in {@link ./persistence.js}; this class stays synchronous and pure.
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
   * Build a pure catalog from durable material after independently revalidating
   * proposal trust, terminal audit history, promotion provenance, and active pointers.
   */
  static restore(
    trust: EvolutionTrustContext,
    material: EvolutionCatalogRestoreMaterial,
  ): EvolutionCatalog {
    const catalog = new EvolutionCatalog(trust);
    catalog.#restoreFromValidatedMaterial(validateRestoreMaterial(catalog.#trust, material));
    return catalog;
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
    origin?: "automatic-controller-v1";
  }): EvolutionProposal {
    return this.#runMutation(() => {
      let proposal: EvolutionProposal;
      try {
        proposal = createEvolutionProposal({
          id: input.id,
          createdAt: input.createdAt,
          policy: input.policy,
          candidate: input.candidate,
          ...(input.origin ? { origin: input.origin } : {}),
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
      // A tombstoned id stays reserved so audit replay never sees a live
      // proposal and a deletion tombstone for the same id.
      if (
        this.#auditRecords.some(
          (record) => record.kind === "delete" && record.proposalId === proposal.id,
        )
      ) {
        throw new EvolutionCatalogConflictError(
          `Proposal id '${proposal.id}' belongs to a deleted proposal and cannot be reused`,
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
    return this.#evaluate(proposalId, evidence, at, "external");
  }

  /** Attach evidence produced by the fixed server-owned structural preflight. */
  evaluateServerPreflight(
    proposalId: string,
    evidence: unknown,
    at: string,
  ): EvolutionProposal {
    return this.#evaluate(proposalId, evidence, at, "server-structural-preflight-v1");
  }

  /** Attach deterministic evidence produced by the bounded automatic run loop. */
  evaluateAutomaticRun(
    proposalId: string,
    evidence: unknown,
    at: string,
  ): EvolutionProposal {
    return this.#evaluate(proposalId, evidence, at, "server-automatic-run-evaluation-v1");
  }

  #evaluate(
    proposalId: string,
    evidence: unknown,
    at: string,
    source: EvolutionEvaluationSource,
  ): EvolutionProposal {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const next = evaluateProposal(current, evidence, at, source);
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
    ...auditBinding: [applicationCommandId?: string]
  ): { proposal: EvolutionProposal; record: PromotionRecord } {
    return this.#runMutation(() => {
      const [applicationCommandId] = auditBinding;
      this.#assertApplicationCommandIdAvailable(applicationCommandId);
      const current = this.#requireProposal(proposalId);
      const targetKey = candidateTargetKey(current.candidate);
      const previousActiveProposalId = this.#activeByTarget.get(targetKey) ?? null;

      const { proposal, record } = promoteProposal({
        proposal: current,
        evidence,
        decision,
        previousActiveProposalId,
        ...(applicationCommandId === undefined ? {} : { applicationCommandId }),
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
    ...auditBinding: [applicationCommandId?: string]
  ): { proposal: EvolutionProposal; record: RollbackRecord } {
    return this.#runMutation(() => {
      const [applicationCommandId] = auditBinding;
      this.#assertApplicationCommandIdAvailable(applicationCommandId);
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
        ...(applicationCommandId === undefined ? {} : { applicationCommandId }),
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

  /**
   * Human-gated archival of a terminal-ish proposal. Presentation-only: the
   * lifecycle status, transitions, and active pointers are left untouched.
   */
  archive(
    proposalId: string,
    decision: unknown,
  ): { proposal: EvolutionProposal; record: ArchiveRecord } {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const { proposal, record } = archiveProposal({
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

  /** Human-gated removal of a proposal's archival marker. */
  unarchive(
    proposalId: string,
    decision: unknown,
  ): { proposal: EvolutionProposal; record: UnarchiveRecord } {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const { proposal, record } = unarchiveProposal({
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
   * Human-gated physical deletion of a rejected proposal. The proposal document
   * is dropped; a tombstone audit record keeps its id, target key, and digest.
   */
  deleteProposal(proposalId: string, decision: unknown): { record: DeletionRecord } {
    return this.#runMutation(() => {
      const current = this.#requireProposal(proposalId);
      const { record } = deleteProposal({
        proposal: current,
        decision,
      });

      return this.#commit((state) => {
        state.proposals.delete(current.id);
        state.auditRecords.push(record);
        return { record: isolate(record) };
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

  /**
   * Export the full authoritative material required for durable persistence,
   * including append-ordered audit records and internal promotion provenance.
   * Snapshot ordering is not used for audit history so reopen preserves order.
   */
  exportDurableMaterial(): EvolutionCatalogRestoreMaterial {
    const proposals = [...this.#proposals.values()]
      .map((proposal) => isolate(proposal))
      .sort(compareProposals);

    const auditRecords = this.#auditRecords.map((record) => isolate(record));

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

    const promotionRecords = [...this.#promotionRecords.values()]
      .map((record) => isolate(record))
      .sort((left, right) => compareCodeUnits(left.proposalId, right.proposalId));

    return deepFreeze({
      proposals,
      auditRecords,
      activeProposals,
      promotionRecords,
    });
  }

  /**
   * Install material already validated by {@link validateRestoreMaterial}.
   */
  #restoreFromValidatedMaterial(material: EvolutionCatalogRestoreMaterial): void {
    if (this.#proposals.size > 0 || this.#auditRecords.length > 0) {
      throw new EvolutionCatalogError("Cannot restore into a non-empty catalog");
    }

    const proposals = new Map<string, EvolutionProposal>();
    for (const proposal of material.proposals) {
      if (proposals.has(proposal.id)) {
        throw new EvolutionCatalogConflictError(
          `Duplicate proposal id '${proposal.id}' in restore material`,
        );
      }
      proposals.set(proposal.id, isolate(proposal));
    }

    const promotionRecords = new Map<string, PromotionRecord>();
    for (const record of material.promotionRecords) {
      if (promotionRecords.has(record.proposalId)) {
        throw new EvolutionCatalogConflictError(
          `Duplicate promotion record for proposal '${record.proposalId}' in restore material`,
        );
      }
      const proposal = proposals.get(record.proposalId);
      if (!proposal) {
        throw new EvolutionCatalogError(
          `Promotion record references missing proposal '${record.proposalId}'`,
        );
      }
      if (proposal.status !== "promoted" && proposal.status !== "rolled-back") {
        throw new EvolutionCatalogError(
          `Promotion record for proposal '${record.proposalId}' requires promoted or rolled-back status`,
        );
      }
      promotionRecords.set(record.proposalId, isolate(record));
    }

    for (const proposal of proposals.values()) {
      if (
        (proposal.status === "promoted" || proposal.status === "rolled-back") &&
        !promotionRecords.has(proposal.id)
      ) {
        throw new EvolutionCatalogError(
          `Proposal '${proposal.id}' is '${proposal.status}' but has no promotion provenance`,
        );
      }
    }

    const auditRecords: AuditRecord[] = [];
    for (const record of material.auditRecords) {
      if (!proposals.has(record.proposalId)) {
        // Tombstone trails (rejection/archival/deletion of a deleted proposal)
        // legitimately reference proposals no longer present; replayRestoreAudit
        // already validated their shape and ordering.
        if (
          record.kind !== "rejection" &&
          record.kind !== "archive" &&
          record.kind !== "unarchive" &&
          record.kind !== "delete"
        ) {
          throw new EvolutionCatalogError(
            `Audit record references missing proposal '${record.proposalId}'`,
          );
        }
      }
      auditRecords.push(isolate(record));
    }

    const activeByTarget = new Map<string, string>();
    for (const pointer of material.activeProposals) {
      const key = candidateTargetKeyFromTarget(pointer.target);
      if (activeByTarget.has(key)) {
        throw new EvolutionCatalogConflictError(
          `Duplicate active pointer for target '${key}'`,
        );
      }
      const proposal = proposals.get(pointer.proposalId);
      if (!proposal) {
        throw new EvolutionCatalogError(
          `Active pointer references missing proposal '${pointer.proposalId}'`,
        );
      }
      if (proposal.status !== "promoted") {
        throw new EvolutionCatalogError(
          `Active pointer for '${pointer.proposalId}' requires promoted status`,
        );
      }
      if (candidateTargetKey(proposal.candidate) !== key) {
        throw new EvolutionCatalogError(
          `Active pointer target does not match proposal '${pointer.proposalId}' candidate`,
        );
      }
      activeByTarget.set(key, pointer.proposalId);
    }

    this.#proposals = proposals;
    this.#auditRecords = auditRecords;
    this.#activeByTarget = activeByTarget;
    this.#promotionRecords = promotionRecords;
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

  #assertApplicationCommandIdAvailable(applicationCommandId: string | undefined): void {
    if (
      applicationCommandId !== undefined &&
      this.#auditRecords.some(
        (record) =>
          "applicationCommandId" in record &&
          record.applicationCommandId === applicationCommandId,
      )
    ) {
      throw new EvolutionCatalogConflictError(
        `Application command '${applicationCommandId}' already owns a catalog audit record`,
      );
    }
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

/**
 * Material used to rebuild a pure in-memory catalog. The public restore entry
 * point revalidates every field against current trust before installing it.
 */
export type EvolutionCatalogRestoreMaterial = {
  readonly proposals: readonly EvolutionProposal[];
  /** Append-ordered audit history as retained at commit time. */
  readonly auditRecords: readonly AuditRecord[];
  readonly activeProposals: readonly EvolutionActiveProposalPointer[];
  /** Internally retained promotion provenance required for rollback. */
  readonly promotionRecords: readonly PromotionRecord[];
};

/**
 * Build a pure catalog from durable material. The restore entry point repeats
 * trust and provenance validation, so callers cannot bypass the catalog boundary.
 */
export function restoreEvolutionCatalog(
  trust: EvolutionTrustContext,
  material: EvolutionCatalogRestoreMaterial,
): EvolutionCatalog {
  return EvolutionCatalog.restore(trust, material);
}

function validateRestoreMaterial(
  trust: EvolutionTrustContext,
  material: EvolutionCatalogRestoreMaterial,
): EvolutionCatalogRestoreMaterial {
  assertRestoreShape(material);
  const proposalById = proposalsById(material.proposals, trust);
  const storedPromotionById = promotionsById(material.promotionRecords, proposalById);
  const activeProposals = parseActivePointers(material.activeProposals);
  const auditRecords = parseAuditRecords(material.auditRecords);
  assertProvenanceMatches(auditRecords, proposalById, storedPromotionById);
  assertActivePointers(activeProposals, auditRecords, proposalById);
  return material;
}

/** Shape before content: an object with exactly the four arrays. */
function assertRestoreShape(material: EvolutionCatalogRestoreMaterial): void {
  if (!material || typeof material !== "object" || Array.isArray(material)) {
    throw new EvolutionValidationError("restore material must be an object");
  }
  assertExactRestoreKeys(
    material as unknown as Record<string, unknown>,
    ["proposals", "auditRecords", "activeProposals", "promotionRecords"],
    "restore material",
  );
  if (
    !Array.isArray(material.proposals) ||
    !Array.isArray(material.auditRecords) ||
    !Array.isArray(material.activeProposals) ||
    !Array.isArray(material.promotionRecords)
  ) {
    throw new EvolutionValidationError("restore material fields must be arrays");
  }
}

function proposalsById(
  raws: readonly unknown[],
  trust: EvolutionTrustContext,
): Map<string, EvolutionProposal> {
  const proposalById = new Map<string, EvolutionProposal>();
  for (const raw of raws) {
    const proposal = parseEvolutionProposal(raw, trust);
    if (proposalById.has(proposal.id)) {
      throw new EvolutionCatalogConflictError(
        `Duplicate proposal id '${proposal.id}' in restore material`,
      );
    }
    proposalById.set(proposal.id, proposal);
  }
  return proposalById;
}

function promotionsById(
  raws: readonly unknown[],
  proposalById: Map<string, EvolutionProposal>,
): Map<string, PromotionRecord> {
  const stored = new Map<string, PromotionRecord>();
  for (const raw of raws) {
    const promotion = parsePromotionRecord(raw);
    if (stored.has(promotion.proposalId)) {
      throw new EvolutionCatalogConflictError(
        `Duplicate promotion record for proposal '${promotion.proposalId}' in restore material`,
      );
    }
    const proposal = proposalById.get(promotion.proposalId);
    if (!proposal) {
      throw new EvolutionCatalogError(
        `Promotion record references missing proposal '${promotion.proposalId}'`,
      );
    }
    assertPromotionRecordMatchesProposal(promotion, proposal);
    stored.set(promotion.proposalId, promotion);
  }
  return stored;
}

function parseAuditRecords(raws: readonly unknown[]): AuditRecord[] {
  return raws.map((raw) => {
    const parsed = auditRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EvolutionValidationError("restore material contains a malformed audit record");
    }
    return parsed.data;
  });
}

/** The declared promotion records must be exactly what the audit replays to. */
function assertProvenanceMatches(
  auditRecords: AuditRecord[],
  proposalById: Map<string, EvolutionProposal>,
  stored: Map<string, PromotionRecord>,
): void {
  const replayed = replayRestoreAudit(auditRecords, proposalById);
  if (stored.size !== replayed.promotionByProposal.size) {
    throw new EvolutionCatalogError("Promotion provenance does not match restore audit history");
  }
  for (const [proposalId, promotion] of replayed.promotionByProposal) {
    if (!deepEqual(stored.get(proposalId), promotion)) {
      throw new EvolutionCatalogError(
        `Promotion provenance for '${proposalId}' does not match restore audit history`,
      );
    }
  }
}

function parseActivePointers(raws: readonly unknown[]): EvolutionActiveProposalPointer[] {
  return raws.map((raw, index) => parseRestoreActivePointer(raw, index));
}

function assertActivePointers(
  activeProposals: EvolutionActiveProposalPointer[],
  auditRecords: AuditRecord[],
  proposalById: Map<string, EvolutionProposal>,
): void {
  const activeByTarget = activeByTargetOf(activeProposals, proposalById);
  const replayed = replayRestoreAudit(auditRecords, proposalById);
  if (activeByTarget.size !== replayed.activeByTarget.size) {
    throw new EvolutionCatalogError("Active pointers do not match restore audit history");
  }
  for (const [targetKey, proposalId] of replayed.activeByTarget) {
    if (activeByTarget.get(targetKey) !== proposalId) {
      throw new EvolutionCatalogError(
        `Active pointer for '${targetKey}' does not match replayed proposal '${proposalId}'`,
      );
    }
  }
}

/** Every pointer must name a promoted proposal for its own target. */
function activeByTargetOf(
  activeProposals: EvolutionActiveProposalPointer[],
  proposalById: Map<string, EvolutionProposal>,
): Map<string, string> {
  const activeByTarget = new Map<string, string>();
  for (const pointer of activeProposals) {
    const targetKey = candidateTargetKeyFromTarget(pointer.target);
    if (activeByTarget.has(targetKey)) {
      throw new EvolutionCatalogConflictError(
        `Duplicate active pointer for target '${targetKey}' in restore material`,
      );
    }
    const proposal = proposalById.get(pointer.proposalId);
    if (
      !proposal ||
      proposal.status !== "promoted" ||
      candidateTargetKey(proposal.candidate) !== targetKey
    ) {
      throw new EvolutionCatalogError(
        `Active pointer '${pointer.proposalId}' is not a promoted proposal for '${targetKey}'`,
      );
    }
    activeByTarget.set(targetKey, pointer.proposalId);
  }
  return activeByTarget;
}

function replayRestoreAudit(
  auditRecords: readonly AuditRecord[],
  proposalById: ReadonlyMap<string, EvolutionProposal>,
): {
  promotionByProposal: Map<string, PromotionRecord>;
  activeByTarget: Map<string, string>;
} {
  const replay: RestoreReplay = {
    proposalById,
    promotionByProposal: new Map(),
    activeByTarget: new Map(),
    counts: new Map(),
    applicationCommandIds: new Set(),
    archivalStates: new Map(),
    deletedTrails: new Map(),
  };
  for (const audit of auditRecords) applyAudit(replay, audit);
  finishReplay(replay);
  return { promotionByProposal: replay.promotionByProposal, activeByTarget: replay.activeByTarget };
}

interface RestoreReplay {
  proposalById: ReadonlyMap<string, EvolutionProposal>;
  promotionByProposal: Map<string, PromotionRecord>;
  activeByTarget: Map<string, string>;
  counts: Map<string, { promotion: number; rejection: number; rollback: number }>;
  applicationCommandIds: Set<string>;
  archivalStates: Map<string, { archived: boolean; at: string | null }>;
  deletedTrails: Map<string, AuditRecord[]>;
}

/** Three destinations: a deleted proposal's trail, an archival marker, or a decision. */
function applyAudit(replay: RestoreReplay, audit: AuditRecord): void {
  const proposal = replay.proposalById.get(audit.proposalId);
  if (!proposal) {
    recordDeletedTrail(replay, audit);
    return;
  }
  if (audit.kind === "delete") {
    throw new EvolutionCatalogError(`Deletion audit references live proposal '${proposal.id}'`);
  }
  claimApplicationCommand(replay, audit);
  if (audit.kind === "archive" || audit.kind === "unarchive") {
    applyArchival(replay, audit, proposal);
    return;
  }
  applyDecision(replay, audit, proposal);
}

/** Only a rejection, archival markers and the tombstone may outlive a proposal. */
const DELETED_TRAIL_KINDS = new Set(["rejection", "archive", "unarchive", "delete"]);

function recordDeletedTrail(replay: RestoreReplay, audit: AuditRecord): void {
  if (!DELETED_TRAIL_KINDS.has(audit.kind)) {
    throw new EvolutionCatalogError(
      `Audit record references missing proposal '${audit.proposalId}'`,
    );
  }
  const trail = replay.deletedTrails.get(audit.proposalId) ?? [];
  trail.push(audit);
  replay.deletedTrails.set(audit.proposalId, trail);
}

/** One application command owns one audit record. */
function claimApplicationCommand(replay: RestoreReplay, audit: AuditRecord): void {
  const commandId = "applicationCommandId" in audit ? audit.applicationCommandId : undefined;
  if (commandId === undefined) return;
  if (replay.applicationCommandIds.has(commandId)) {
    throw new EvolutionCatalogError(
      `Application command '${commandId}' owns multiple audit records`,
    );
  }
  replay.applicationCommandIds.add(commandId);
}

function applyArchival(
  replay: RestoreReplay,
  audit: AuditRecord,
  proposal: EvolutionProposal,
): void {
  const state = replay.archivalStates.get(proposal.id) ?? { archived: false, at: null };
  const archiving = audit.kind === "archive";
  if (archiving === state.archived) {
    throw new EvolutionCatalogError(
      archiving
        ? `Duplicate archive audit for '${proposal.id}'`
        : `Unarchive audit for '${proposal.id}' is out of order`,
    );
  }
  replay.archivalStates.set(proposal.id, { archived: archiving, at: archiving ? audit.at : null });
}

type DecisionKind = "promotion" | "rejection" | "rollback";

function applyDecision(
  replay: RestoreReplay,
  audit: AuditRecord,
  proposal: EvolutionProposal,
): void {
  const kind = audit.kind as DecisionKind;
  const count = replay.counts.get(proposal.id) ?? { promotion: 0, rejection: 0, rollback: 0 };
  count[kind] += 1;
  replay.counts.set(proposal.id, count);
  if (kind === "promotion") return applyPromotion(replay, audit, proposal, count);
  if (kind === "rollback") return applyRollback(replay, audit, proposal, count);
  applyRejection(replay, audit, proposal, count);
}

function applyPromotion(
  replay: RestoreReplay,
  audit: AuditRecord,
  proposal: EvolutionProposal,
  count: { promotion: number },
): void {
  if (count.promotion !== 1) {
    throw new EvolutionCatalogError(`Duplicate promotion audit for '${proposal.id}'`);
  }
  const promotion = audit as Extract<AuditRecord, { kind: "promotion" }>;
  assertPromotionRecordMatchesProposal(promotion, proposal);
  assertRestoreTransitionAt(proposal, "evaluated", "promoted", promotion.at);
  const targetKey = candidateTargetKey(proposal.candidate);
  assertPromotionChain(replay, promotion, proposal.id, targetKey);
  replay.promotionByProposal.set(proposal.id, promotion);
  replay.activeByTarget.set(targetKey, proposal.id);
}

function applyRollback(
  replay: RestoreReplay,
  audit: AuditRecord,
  proposal: EvolutionProposal,
  count: { rollback: number },
): void {
  if (count.rollback !== 1) {
    throw new EvolutionCatalogError(`Duplicate rollback audit for '${proposal.id}'`);
  }
  const rollback = audit as Extract<AuditRecord, { kind: "rollback" }>;
  const targetKey = candidateTargetKey(proposal.candidate);
  const promotion = replay.promotionByProposal.get(proposal.id);
  if (!promotion || replay.activeByTarget.get(targetKey) !== proposal.id) {
    throw new EvolutionCatalogError(`Rollback audit for '${proposal.id}' is out of order`);
  }
  assertRestoreTransitionAt(proposal, "promoted", "rolled-back", rollback.at);
  if (rollback.restoredActiveProposalId !== promotion.previousActiveProposalId) {
    throw new EvolutionCatalogError(
      `Rollback restoration for '${proposal.id}' does not match promotion provenance`,
    );
  }
  restoreActive(replay, targetKey, rollback.restoredActiveProposalId);
}

function restoreActive(replay: RestoreReplay, targetKey: string, restoredId: string | null): void {
  if (restoredId === null) {
    replay.activeByTarget.delete(targetKey);
    return;
  }
  if (!isPriorPromotion(replay, restoredId, targetKey)) {
    throw new EvolutionCatalogError(
      `Rollback target '${restoredId}' is not a prior promotion for the same target`,
    );
  }
  replay.activeByTarget.set(targetKey, restoredId);
}

/** The declared predecessor must be the one the replay already promoted. */
function assertPromotionChain(
  replay: RestoreReplay,
  promotion: Extract<AuditRecord, { kind: "promotion" }>,
  proposalId: string,
  targetKey: string,
): void {
  const previousActive = replay.activeByTarget.get(targetKey) ?? null;
  if (promotion.previousActiveProposalId !== previousActive) {
    throw new EvolutionCatalogError(
      `Promotion previous active for '${proposalId}' does not match replay history`,
    );
  }
  if (previousActive !== null && !isPriorPromotion(replay, previousActive, targetKey)) {
    throw new EvolutionCatalogError(
      `Promotion previous active '${previousActive}' is not a prior promotion for the same target`,
    );
  }
}

function isPriorPromotion(replay: RestoreReplay, id: string, targetKey: string): boolean {
  const previous = replay.proposalById.get(id);
  if (!previous) return false;
  if (candidateTargetKey(previous.candidate) !== targetKey) return false;
  return replay.promotionByProposal.has(previous.id);
}

function applyRejection(
  replay: RestoreReplay,
  audit: AuditRecord,
  proposal: EvolutionProposal,
  count: { rejection: number },
): void {
  if (count.rejection !== 1) {
    throw new EvolutionCatalogError(`Duplicate rejection audit for '${proposal.id}'`);
  }
  const rejection = audit as Extract<AuditRecord, { kind: "rejection" }>;
  assertRestoreTransitionAt(proposal, "evaluated", "rejected", rejection.at);
  if (!proposal.evaluation || !deepEqual(rejection.evaluation, proposal.evaluation.result)) {
    throw new EvolutionCatalogError(
      `Rejection evaluation for '${proposal.id}' does not match proposal evidence`,
    );
  }
}

/** After the loop: every deleted trail, then every proposal's archival state. */
function finishReplay(replay: RestoreReplay): void {
  for (const [proposalId, trail] of replay.deletedTrails) {
    assertDeletedAuditTrail(proposalId, trail);
  }
  for (const proposal of replay.proposalById.values()) {
    assertArchivalMatches(replay, proposal);
  }
}

function assertArchivalMatches(replay: RestoreReplay, proposal: EvolutionProposal): void {
  const state = replay.archivalStates.get(proposal.id) ?? { archived: false, at: null };
  if (
    state.archived === (proposal.archivedAt !== undefined) &&
    (!state.archived || proposal.archivedAt === state.at)
  ) {
    return;
  }
  throw new EvolutionCatalogError(
    `Archival state for '${proposal.id}' does not match restore audit history`,
  );
}

/**
 * Validate the retained audit trail of a deleted proposal: exactly one
 * rejection first, exactly one deletion tombstone last, and alternating
 * archive/unarchive markers in between.
 */
function assertDeletedAuditTrail(proposalId: string, trail: readonly AuditRecord[]): void {
  const violation = auditTrailViolation(trail.map((record) => record.kind));
  if (violation) throw new EvolutionCatalogError(violation.message(proposalId));
}

function assertRestoreTransitionAt(
  proposal: EvolutionProposal,
  from: EvolutionProposal["status"],
  to: EvolutionProposal["status"],
  at: string,
): void {
  const matches = proposal.transitions.filter(
    (transition) => transition.from === from && transition.to === to,
  );
  if (matches.length !== 1 || matches[0]!.at !== at) {
    throw new EvolutionCatalogError(
      `Audit timestamp for '${proposal.id}' does not match '${from}' -> '${to}' transition`,
    );
  }
}

function parseRestoreActivePointer(
  raw: unknown,
  index: number,
): EvolutionActiveProposalPointer {
  const label = `activeProposals[${index}]`;
  const record = asPointerObject(raw, label);
  assertExactRestoreKeys(record, ["target", "proposalId"], label);
  const proposalId = requiredString(record.proposalId, `${label}.proposalId`);
  const target = asPointerObject(record.target, `${label}.target`);
  return { target: parsePointerTarget(target, label), proposalId };
}

function asPointerObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvolutionValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvolutionValidationError(`${label} is required`);
  }
  return value;
}

type PointerTarget = EvolutionActiveProposalPointer["target"];

/** One reader per supported target kind. */
const POINTER_TARGETS: Record<string, (target: Record<string, unknown>, label: string) => PointerTarget> = {
  "strategy-blueprint": (target, label) => {
    assertExactRestoreKeys(target, ["kind", "name"], `${label}.target`);
    return { kind: "strategy-blueprint", name: requiredString(target.name, `${label}.target.name`) };
  },
  "role-prompt": (target, label) => {
    assertExactRestoreKeys(target, ["kind", "path"], `${label}.target`);
    return { kind: "role-prompt", path: requiredString(target.path, `${label}.target.path`) };
  },
};

function parsePointerTarget(target: Record<string, unknown>, label: string): PointerTarget {
  const read = POINTER_TARGETS[String(target.kind)];
  if (!read) {
    throw new EvolutionValidationError(`${label}.target.kind is unsupported`);
  }
  return read(target, label);
}

function assertExactRestoreKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((key) => !expected.has(key)) ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new EvolutionValidationError(`${label} contains missing or unexpected fields`);
  }
}

function snapshotTrustContext(trust: EvolutionTrustContext): EvolutionTrustContext {
  assertTrustShape(trust);
  return {
    ...trust,
    configuredRolePromptPaths: trust.configuredRolePromptPaths.map(stringOf),
    roleAllowedProfiles: profileSnapshot(trust.roleAllowedProfiles),
  };
}

function assertTrustShape(trust: EvolutionTrustContext): void {
  if (
    !trust ||
    !Array.isArray(trust.configuredRolePromptPaths) ||
    !trust.roleAllowedProfiles ||
    typeof trust.roleAllowedProfiles !== "object" ||
    Array.isArray(trust.roleAllowedProfiles)
  ) {
    throw new EvolutionValidationError("trust: A valid EvolutionTrustContext is required");
  }
}

function stringOf(path: unknown): string {
  if (typeof path !== "string") {
    throw new EvolutionValidationError("trust.configuredRolePromptPaths must contain strings");
  }
  return path;
}

function profileSnapshot(
  roleAllowedProfiles: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  const snapshot = Object.create(null) as Record<string, readonly string[]>;
  for (const [role, profiles] of Object.entries(roleAllowedProfiles)) {
    snapshot[role] = profilesOf(role, profiles);
  }
  return snapshot;
}

function profilesOf(role: string, profiles: unknown): readonly string[] {
  if (!Array.isArray(profiles) || profiles.some((profile) => typeof profile !== "string")) {
    throw new EvolutionValidationError(
      `trust.roleAllowedProfiles.${role} must contain profile-name strings`,
    );
  }
  return [...profiles];
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

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortObjectKeys(left)) === JSON.stringify(sortObjectKeys(right));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
