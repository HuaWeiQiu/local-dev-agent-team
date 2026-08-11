import {
  assertPromotionRecordMatchesProposal,
  auditRecordSchema,
  createEvolutionProposal,
  evaluateProposal,
  EvolutionDomainError,
  EvolutionValidationError,
  parseEvolutionProposal,
  parsePromotionRecord,
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
        throw new EvolutionCatalogError(
          `Audit record references missing proposal '${record.proposalId}'`,
        );
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

  const proposals: EvolutionProposal[] = [];
  const proposalById = new Map<string, EvolutionProposal>();
  for (const raw of material.proposals) {
    const proposal = parseEvolutionProposal(raw, trust);
    if (proposalById.has(proposal.id)) {
      throw new EvolutionCatalogConflictError(
        `Duplicate proposal id '${proposal.id}' in restore material`,
      );
    }
    proposalById.set(proposal.id, proposal);
    proposals.push(proposal);
  }

  const promotionRecords: PromotionRecord[] = [];
  const storedPromotionById = new Map<string, PromotionRecord>();
  for (const raw of material.promotionRecords) {
    const promotion = parsePromotionRecord(raw);
    if (storedPromotionById.has(promotion.proposalId)) {
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
    storedPromotionById.set(promotion.proposalId, promotion);
    promotionRecords.push(promotion);
  }

  const auditRecords: AuditRecord[] = [];
  for (const raw of material.auditRecords) {
    const parsed = auditRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EvolutionValidationError("restore material contains a malformed audit record");
    }
    auditRecords.push(parsed.data);
  }

  const replayed = replayRestoreAudit(auditRecords, proposalById);
  if (storedPromotionById.size !== replayed.promotionByProposal.size) {
    throw new EvolutionCatalogError("Promotion provenance does not match restore audit history");
  }
  for (const [proposalId, promotion] of replayed.promotionByProposal) {
    if (!deepEqual(storedPromotionById.get(proposalId), promotion)) {
      throw new EvolutionCatalogError(
        `Promotion provenance for '${proposalId}' does not match restore audit history`,
      );
    }
  }

  const activeProposals = material.activeProposals.map((raw, index) =>
    parseRestoreActivePointer(raw, index),
  );
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

  return deepFreeze({ proposals, auditRecords, activeProposals, promotionRecords });
}

function replayRestoreAudit(
  auditRecords: readonly AuditRecord[],
  proposalById: ReadonlyMap<string, EvolutionProposal>,
): {
  promotionByProposal: Map<string, PromotionRecord>;
  activeByTarget: Map<string, string>;
} {
  const promotionByProposal = new Map<string, PromotionRecord>();
  const activeByTarget = new Map<string, string>();
  const counts = new Map<string, { promotion: number; rejection: number; rollback: number }>();

  for (const audit of auditRecords) {
    const proposal = proposalById.get(audit.proposalId);
    if (!proposal) {
      throw new EvolutionCatalogError(
        `Audit record references missing proposal '${audit.proposalId}'`,
      );
    }
    const count = counts.get(proposal.id) ?? { promotion: 0, rejection: 0, rollback: 0 };
    count[audit.kind] += 1;
    counts.set(proposal.id, count);
    const targetKey = candidateTargetKey(proposal.candidate);

    if (audit.kind === "promotion") {
      if (count.promotion !== 1) {
        throw new EvolutionCatalogError(`Duplicate promotion audit for '${proposal.id}'`);
      }
      assertPromotionRecordMatchesProposal(audit, proposal);
      assertRestoreTransitionAt(proposal, "evaluated", "promoted", audit.at);
      const previousActive = activeByTarget.get(targetKey) ?? null;
      if (audit.previousActiveProposalId !== previousActive) {
        throw new EvolutionCatalogError(
          `Promotion previous active for '${proposal.id}' does not match replay history`,
        );
      }
      if (previousActive !== null) {
        const previous = proposalById.get(previousActive);
        if (
          !previous ||
          candidateTargetKey(previous.candidate) !== targetKey ||
          !promotionByProposal.has(previous.id)
        ) {
          throw new EvolutionCatalogError(
            `Promotion previous active '${previousActive}' is not a prior promotion for the same target`,
          );
        }
      }
      promotionByProposal.set(proposal.id, audit);
      activeByTarget.set(targetKey, proposal.id);
      continue;
    }

    if (audit.kind === "rollback") {
      if (count.rollback !== 1) {
        throw new EvolutionCatalogError(`Duplicate rollback audit for '${proposal.id}'`);
      }
      const promotion = promotionByProposal.get(proposal.id);
      if (!promotion || activeByTarget.get(targetKey) !== proposal.id) {
        throw new EvolutionCatalogError(`Rollback audit for '${proposal.id}' is out of order`);
      }
      assertRestoreTransitionAt(proposal, "promoted", "rolled-back", audit.at);
      if (audit.restoredActiveProposalId !== promotion.previousActiveProposalId) {
        throw new EvolutionCatalogError(
          `Rollback restoration for '${proposal.id}' does not match promotion provenance`,
        );
      }
      if (audit.restoredActiveProposalId === null) {
        activeByTarget.delete(targetKey);
      } else {
        const restored = proposalById.get(audit.restoredActiveProposalId);
        if (
          !restored ||
          candidateTargetKey(restored.candidate) !== targetKey ||
          !promotionByProposal.has(restored.id)
        ) {
          throw new EvolutionCatalogError(
            `Rollback target '${audit.restoredActiveProposalId}' is not a prior promotion for the same target`,
          );
        }
        activeByTarget.set(targetKey, restored.id);
      }
      continue;
    }

    if (count.rejection !== 1) {
      throw new EvolutionCatalogError(`Duplicate rejection audit for '${proposal.id}'`);
    }
    assertRestoreTransitionAt(proposal, "evaluated", "rejected", audit.at);
    if (!proposal.evaluation || !deepEqual(audit.evaluation, proposal.evaluation.result)) {
      throw new EvolutionCatalogError(
        `Rejection evaluation for '${proposal.id}' does not match proposal evidence`,
      );
    }
  }

  for (const proposal of proposalById.values()) {
    const count = counts.get(proposal.id) ?? { promotion: 0, rejection: 0, rollback: 0 };
    const expected =
      proposal.status === "rejected"
        ? { promotion: 0, rejection: 1, rollback: 0 }
        : proposal.status === "promoted"
          ? { promotion: 1, rejection: 0, rollback: 0 }
          : proposal.status === "rolled-back"
            ? { promotion: 1, rejection: 0, rollback: 1 }
            : { promotion: 0, rejection: 0, rollback: 0 };
    if (!deepEqual(count, expected)) {
      throw new EvolutionCatalogError(
        `Terminal audit cardinality for '${proposal.id}' does not match '${proposal.status}'`,
      );
    }
  }

  return { promotionByProposal, activeByTarget };
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EvolutionValidationError(`activeProposals[${index}] must be an object`);
  }
  const record = raw as Record<string, unknown>;
  assertExactRestoreKeys(record, ["target", "proposalId"], `activeProposals[${index}]`);
  if (typeof record.proposalId !== "string" || !record.proposalId.trim()) {
    throw new EvolutionValidationError(`activeProposals[${index}].proposalId is required`);
  }
  if (!record.target || typeof record.target !== "object" || Array.isArray(record.target)) {
    throw new EvolutionValidationError(`activeProposals[${index}].target is required`);
  }
  const target = record.target as Record<string, unknown>;
  if (target.kind === "strategy-blueprint") {
    assertExactRestoreKeys(target, ["kind", "name"], `activeProposals[${index}].target`);
    if (typeof target.name !== "string" || !target.name.trim()) {
      throw new EvolutionValidationError(`activeProposals[${index}].target.name is required`);
    }
    return { target: { kind: "strategy-blueprint", name: target.name }, proposalId: record.proposalId };
  }
  if (target.kind === "role-prompt") {
    assertExactRestoreKeys(target, ["kind", "path"], `activeProposals[${index}].target`);
    if (typeof target.path !== "string" || !target.path.trim()) {
      throw new EvolutionValidationError(`activeProposals[${index}].target.path is required`);
    }
    return { target: { kind: "role-prompt", path: target.path }, proposalId: record.proposalId };
  }
  throw new EvolutionValidationError(`activeProposals[${index}].target.kind is unsupported`);
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
