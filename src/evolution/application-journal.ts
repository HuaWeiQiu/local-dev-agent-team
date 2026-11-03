import { randomBytes } from "node:crypto";
import path from "node:path";
import { clearPromptTemplateCache } from "../agents/service.js";
import { type GitManager } from "../git/manager.js";
import type { EvolutionCatalogSnapshot } from "./catalog.js";
import {
  computeCandidateDigest,
  type EvolutionProposal,
  type HumanDecision,
  type PromotionRecord,
  type RollbackRecord,
} from "./domain.js";
import {
  computePayloadDigest,
  type DurableEvolutionCatalog,
  EvolutionPersistenceValidationError,
} from "./persistence.js";
import { applicationPayloadSchema } from "./application-schemas.js";
import {
  EVOLUTION_APPLICATION_DOCUMENT_VERSION,
  EvolutionApplicationError,
  MAX_APPLICATION_HISTORY_DEPTH,
  applicationHistoryHasCommand,
  escapeRegExp,
  isolate,
  isNotFound,
  sha256Canonical,
  targetFromCandidate,
  targetKey,
  targetKeyFromState,
  targetStatesEqual,
  type ApplicationDocument,
  type ApplicationPayload,
  type CompletedApplicationRecord,
  type ApplicationRecord,
  type ApplicationStatus,
  type CommandIdempotencyBinding,
  type EvolutionApplicationFileIo,
  type EvolutionApplicationState,
  type PendingApplicationOperation,
  type TargetDigestState,
} from "./application-shared.js";
import {
  assertSafeRegularFileOrMissing,
  type EvolutionApplicationTargets,
} from "./application-target.js";

/** One recorded proof against the application it claims to prove, field for field. */
function completionView(completion: CompletedApplicationRecord): Record<string, unknown> {
  return {
    proposalId: completion.proposalId,
    candidateDigest: completion.candidateDigest,
    status: completion.status,
    beforeTargetDigest: completion.beforeTargetDigest,
    afterTargetDigest: completion.afterTargetDigest,
    catalogRevisionAfter: completion.catalogRevisionAfter,
    operator: completion.operator,
    reason: completion.reason,
    "humanDecision.actor": completion.humanDecision.actor,
    "humanDecision.decidedAt": completion.humanDecision.decidedAt,
  };
}

function applicationCompletionView(application: ApplicationRecord): Record<string, unknown> {
  return {
    proposalId: application.proposalId,
    candidateDigest: application.candidateDigest,
    status: application.status,
    beforeTargetDigest: application.beforeTargetDigest,
    afterTargetDigest: application.afterTargetDigest,
    catalogRevisionAfter: application.catalogRevision,
    operator: application.operator,
    reason: application.reason,
    "humanDecision.actor": application.operator,
    "humanDecision.decidedAt": application.appliedAt,
  };
}

function commandView(command: CommandIdempotencyBinding): Record<string, unknown> {
  return {
    operator: command.operator,
    reason: command.reason,
    "result.applicationStatus": command.result.applicationStatus,
    "result.beforeTargetDigest": command.result.beforeTargetDigest,
    "result.afterTargetDigest": command.result.afterTargetDigest,
    "result.committedCatalogRevision": command.result.committedCatalogRevision,
  };
}

function applicationCommandView(application: ApplicationRecord): Record<string, unknown> {
  return {
    operator: application.operator,
    reason: application.reason,
    "result.applicationStatus": application.status,
    "result.beforeTargetDigest": application.beforeTargetDigest,
    "result.afterTargetDigest": application.afterTargetDigest,
    "result.committedCatalogRevision": application.catalogRevision,
  };
}

/** The operation-specific half of the proof: each operation carries extra requirements. */
function operationChecks(input: ProofInput): Array<{ field: string; holds: boolean }> {
  const { application, completion, command } = input;
  if (completion === undefined) return [];
  if (completion.operation === "promote-and-apply") {
    return [
      { field: "command", holds: command !== undefined },
      { field: "command.operation", holds: command === undefined || command.operation === "promote-and-apply" },
      { field: "application.rollbackSafe", holds: application.rollbackSafe },
      { field: "application.status", holds: application.status === "applied" },
    ];
  }
  if (completion.operation !== "reconcile-promoted") return [];
  const withoutCommandAllowed =
    input.syntheticLegacyBaseline && COMMAND_FALLBACK["reconcile-promoted"] !== null;
  return [
    { field: "completion.status", holds: completion.status === application.status },
    { field: "command.operation", holds: command === undefined || command.operation === "reconcile-promoted" },
    { field: "application.status", holds: command === undefined || input.reconcileStatusMatches },
    {
      field: "application.rollbackSafe",
      holds: command === undefined || application.rollbackSafe === input.reconcileRollbackSafe,
    },
    { field: "syntheticLegacyBaseline", holds: command !== undefined || withoutCommandAllowed },
  ];
}

/** Dot-paths of the fields where `actual` disagrees with `expected`; empty means agreement. */
export function mismatchedFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): string[] {
  return Object.keys(expected).filter((field) => {
    const wanted = expected[field];
    const got = actual[field];
    return wanted !== null && typeof wanted === "object"
      ? sha256Canonical(got ?? null) !== sha256Canonical(wanted)
      : got !== wanted;
  });
}

/** The command an audit record claims, when it claims one at all. */
function auditCommandId(audit: EvolutionCatalogSnapshot["auditRecords"][number]): string | undefined {
  if (
    audit.kind === "rejection" ||
    audit.kind === "archive" ||
    audit.kind === "unarchive" ||
    audit.kind === "delete" ||
    !("applicationCommandId" in audit)
  ) {
    return undefined;
  }
  return audit.applicationCommandId;
}

/** The fields whose check failed, in declaration order — every check is evaluated. */
function settle(checks: Array<{ field: string; holds: boolean }>): string[] {
  return checks.filter((check) => !check.holds).map((check) => check.field);
}

function prefixed(prefix: string, fields: string[]): string[] {
  return fields.map((field) => `${prefix}.${field}`);
}

/**
 * Which operation may legitimately carry **no** idempotency binding, and what vouches for it
 * instead. This is not an oversight to be tidied away: a legacy Phase-2 promotion was
 * recorded in the catalog before the journal existed, so its proof has no command to point
 * at. Whoever "unifies" the checks below must delete this table first — and this comment
 * says why that would be wrong.
 */
const COMMAND_FALLBACK = {
  // The journal always writes a binding for work it started.
  "promote-and-apply": null,
  // A captured legacy predecessor is proven by its own synthetic baseline, not by a command.
  "reconcile-promoted": "syntheticLegacyBaseline",
  // Any other operation proves itself through the catalog revision the completion recorded.
  fallback: "completion.catalogRevisionBefore",
} as const;

/** What a proof check needs: the record, what the catalog says, and the derived flags. */
type ProofInput = {
  application: ApplicationRecord;
  revision: number;
  proposal: EvolutionProposal | undefined;
  completion: CompletedApplicationRecord | undefined;
  command: CommandIdempotencyBinding | undefined;
  expectedAfterTarget: TargetDigestState | null;
  reconcileStatusMatches: boolean;
  reconcileRollbackSafe: boolean;
  syntheticLegacyBaseline: boolean;
};

/** Everything the restored-state checks read: one catalog snapshot and the journal state. */
type RestoredStateContext = {
  revision: number;
  snapshot: EvolutionCatalogSnapshot;
  proposals: Map<string, EvolutionProposal>;
  activeByTarget: Map<string, string>;
  promotionByProposal: Map<string, PromotionRecord>;
  completedByCommand: Map<string, CompletedApplicationRecord>;
  syntheticCompletionIds: Set<string>;
};

export interface EvolutionApplicationJournalEnvironment {
  readonly io: EvolutionApplicationFileIo;
  readonly catalog: DurableEvolutionCatalog;
  readonly git: GitManager;
  readonly targets: EvolutionApplicationTargets;
  readonly state: EvolutionApplicationState;
  readonly evolutionDirectory: string;
  readonly applicationFilePath: string;
  readonly now: () => number;
}

/**
 * Write-ahead journal for application commands: durable load/validation,
 * crash-time pending reconciliation, and atomic persisted-state transitions.
 * All methods run on the coordinator's serial queue; the journal never
 * reorders or retries on its own.
 */
type ReconcileSituation = "aborted" | "finalize" | "finish" | "unknown";

interface ReconcileState {
  situation: ReconcileSituation;
  liveTarget: TargetDigestState;
  revision: number;
}

interface ReconcileFacts {
  targetIsOld: boolean;
  targetIsNew: boolean;
  catalogIsOld: boolean;
  catalogIsNew: boolean;
  promptGitApplied: boolean;
  candidateKind: string;
}

/**
 * The crash matrix: the application is only safe to settle when exactly one
 * side moved, or when the prompt git work already landed.
 */
export function pickSituation(facts: ReconcileFacts): ReconcileSituation {
  if (facts.targetIsOld && facts.catalogIsOld) return "aborted";
  if (facts.targetIsNew && facts.catalogIsNew && facts.promptGitApplied) return "finalize";
  if (facts.targetIsNew && facts.catalogIsOld) return "finish";
  return "unknown";
}

/** The rename landed; only the directory fsync failed. */
class RenameCompletedButSyncFailed extends Error {
  constructor(readonly cause: unknown) {
    super("directory fsync failed after rename");
  }
}

export class EvolutionApplicationJournal {
  readonly #io: EvolutionApplicationFileIo;
  readonly #catalog: DurableEvolutionCatalog;
  readonly #git: GitManager;
  readonly #targets: EvolutionApplicationTargets;
  readonly #state: EvolutionApplicationState;
  readonly #evolutionDirectory: string;
  readonly #applicationFilePath: string;
  readonly #now: () => number;

  constructor(environment: EvolutionApplicationJournalEnvironment) {
    this.#io = environment.io;
    this.#catalog = environment.catalog;
    this.#git = environment.git;
    this.#targets = environment.targets;
    this.#state = environment.state;
    this.#evolutionDirectory = environment.evolutionDirectory;
    this.#applicationFilePath = environment.applicationFilePath;
    this.#now = environment.now;
  }

  async loadOrInit(): Promise<void> {
    try {
      await assertSafeRegularFileOrMissing(
        this.#io,
        this.#catalog.root,
        this.#applicationFilePath,
      );
      const text = await this.#io.readFile(this.#applicationFilePath, "utf8");
      const restored = parseApplicationDocument(text, this.#applicationFilePath);
      this.#state.persistedContents = text;
      this.#state.revision = restored.revision;
      this.#state.applications = new Map(
        restored.payload.applications.map((record) => [record.proposalId, record]),
      );
      this.#state.pending = restored.payload.pending;
      this.#state.completed = [...restored.payload.completed];
      this.#state.commands = new Map(
        restored.payload.commands.map((binding) => [binding.commandId, binding]),
      );
      this.#state.recoveryRequired = restored.payload.recoveryRequired;
      await this.validateRestoredState();
    } catch (error) {
      if (isNotFound(error)) {
        this.#state.revision = 0;
        this.#state.applications = new Map();
        this.#state.pending = null;
        this.#state.completed = [];
        this.#state.commands = new Map();
        this.#state.recoveryRequired = false;
        this.#state.persistedContents = null;
        return;
      }
      throw error;
    }
  }

  /**
   * One recorded application proof against the catalog, at the depth of its predecessor
   * chain. A proof only means something while the catalog still agrees with it: same
   * candidate, same target, same completion, and — for a chained promotion — a predecessor
   * that is itself valid.
   */
  private async validateApplicationProof(
    application: ApplicationRecord,
    input: RestoredStateContext,
    parentCommandId: string | null = null,
  ): Promise<void> {
    const proposal = input.proposals.get(application.proposalId);
    const completion = input.completedByCommand.get(application.commandId);
    const command = this.#state.commands.get(application.commandId);
    const expectedAfterTarget = proposal
      ? await this.#targets.plannedAfterState(proposal, application.beforeTarget)
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
      parentCommandId === this.#state.pending?.commandId &&
      this.#state.pending.operation === "reconcile-promoted"
    ) {
      syntheticOwners.push({
        commandId: this.#state.pending.commandId,
        proposalId: this.#state.pending.proposalId,
        reason: this.#state.pending.reason,
        humanDecision: this.#state.pending.humanDecision,
      });
    }
    for (const ownerCommand of this.#state.commands.values()) {
      if (
        ownerCommand.operation !== "reconcile-promoted" ||
        (parentCommandId !== null && ownerCommand.commandId !== parentCommandId)
      ) {
        continue;
      }
      const ownerCompletion = input.completedByCommand.get(ownerCommand.commandId);
      if (!ownerCompletion) continue;
      syntheticOwners.push({
        commandId: ownerCommand.commandId,
        proposalId: ownerCommand.proposalId,
        reason: ownerCommand.reason,
        humanDecision: ownerCompletion.humanDecision,
      });
    }
    const syntheticOwner = syntheticOwners.find((owner) => {
      const ownerPromotion = input.promotionByProposal.get(owner.proposalId);
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
      input.syntheticCompletionIds.add(application.commandId);
    }
    const mismatches = this.proofMismatches({
      application,
      revision: input.revision,
      proposal,
      completion,
      command,
      expectedAfterTarget,
      reconcileStatusMatches,
      reconcileRollbackSafe,
      syntheticLegacyBaseline,
    });
    if (mismatches.length > 0) {
      throw new EvolutionPersistenceValidationError(
        `Invalid application state: application proof for '${application.proposalId}' does not match the catalog (${mismatches.join(", ")})`,
      );
    }
    if (application.previousApplication) {
      await this.validateApplicationProof(application.previousApplication, input, application.commandId);
    }
    
  }

  /**
   * Which fields of a recorded proof disagree with the catalog, named by dot path.
   *
   * The comparisons used to be a single `&&` chain: every field added a clause, the whole
   * thing counted as one enormous branch, and the refusal said only "does not match the
   * catalog". Naming the fields keeps a new field from silently extending a chain and — the
   * reason it matters — tells an operator *which* field disagreed, which is the difference
   * between "state invalid" and "completion.status says 'applied' where the application
   * says 'adopted'".
   */
  private proofMismatches(input: ProofInput): string[] {
    const { application, completion, command } = input;
    const pairs: Array<[string, Record<string, unknown> | undefined, Record<string, unknown>]> = [
      [
        "completion",
        completion === undefined ? undefined : completionView(completion),
        applicationCompletionView(application),
      ],
      [
        "command",
        command === undefined ? undefined : commandView(command),
        applicationCommandView(application),
      ],
    ];
    // A missing completion is always a mismatch. A missing command is not: it is the
    // legacy Phase-2 shape, and each operation decides for itself whether that is allowed
    // (`operationChecks`, plus the catalogRevisionBefore check below).
    const mismatches: string[] = completion === undefined ? ["completion"] : [];
    for (const [name, actual, expected] of pairs) {
      if (actual === undefined) continue;
      mismatches.push(...prefixed(name, mismatchedFields(actual, expected)));
    }
    const checks: Array<{ field: string; holds: boolean }> = [
      { field: "proposal", holds: input.proposal !== undefined },
      { field: "expectedAfterTarget", holds: input.expectedAfterTarget !== null },
      { field: "application.catalogRevision", holds: application.catalogRevision <= input.revision },
      {
        field: "application.afterTarget",
        holds:
          input.expectedAfterTarget === null ||
          targetStatesEqual(application.afterTarget, input.expectedAfterTarget),
      },
      {
        field: "catalog.candidateDigest",
        holds:
          input.proposal === undefined ||
          computeCandidateDigest(input.proposal.candidate) === application.candidateDigest,
      },
      {
        field: "catalog.target",
        holds:
          input.proposal === undefined ||
          targetKey(targetFromCandidate(input.proposal.candidate)) === targetKey(application.target),
      },
      {
        field: COMMAND_FALLBACK.fallback,
        holds:
          command !== undefined ||
          completion === undefined ||
          completion.catalogRevisionBefore === application.catalogRevision,
      },
      ...operationChecks(input),
    ];
    mismatches.push(...settle(checks));
    return [...new Set(mismatches)];
  }

  async validateRestoredState(): Promise<void> {
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
      this.#state.completed.map((record) => [record.commandId, record]),
    );
    const context: RestoredStateContext = {
      revision,
      snapshot,
      proposals,
      activeByTarget,
      promotionByProposal,
      completedByCommand,
      syntheticCompletionIds: new Set<string>(),
    };
    for (const application of this.#state.applications.values()) {
      await this.validateApplicationProof(application, context);
      const activeId = activeByTarget.get(targetKey(application.target));
      const committedPendingRollback =
        this.#state.pending?.operation === "rollback-applied" &&
        this.#state.pending.proposalId === application.proposalId &&
        revision === this.#state.pending.expectedCatalogRevisionAfter &&
        this.catalogOutcomeMatchesPending(this.#state.pending, snapshot, revision);
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
    if (this.#state.pending) {
      const proposal = proposals.get(this.#state.pending.proposalId);
      const pendingTarget = proposal ? targetFromCandidate(proposal.candidate) : null;
      const activeId = pendingTarget ? activeByTarget.get(targetKey(pendingTarget)) ?? null : null;
      const expectedOldActive =
        this.#state.pending.operation === "promote-and-apply"
          ? this.#state.pending.previousActiveProposalId
          : this.#state.pending.proposalId;
      const expectedPreviousApplication =
        this.#state.pending.operation === "promote-and-apply"
          ? this.#state.pending.previousActiveProposalId
            ? (this.#state.applications.get(this.#state.pending.previousActiveProposalId) ?? null)
            : null
          : this.#state.pending.operation === "rollback-applied"
            ? (this.#state.applications.get(this.#state.pending.proposalId) ?? null)
            : this.#state.pending.previousApplication;
      let reconcileRestoredId: string | null | undefined;
      if (this.#state.pending.operation === "reconcile-promoted") {
        reconcileRestoredId = (
          await this.#catalog.preflightRollback(
            this.#state.pending.proposalId,
            this.#state.pending.humanDecision,
          )
        ).record.restoredActiveProposalId;
        if (this.#state.pending.previousApplication) {
          await this.validateApplicationProof(
            this.#state.pending.previousApplication,
            context,
            this.#state.pending.commandId,
          );
        }
      }
      let expectedPendingBefore: TargetDigestState | null = null;
      let expectedPendingAfter: TargetDigestState | null = null;
      if (proposal) {
        if (
          this.#state.pending.operation === "rollback-applied" &&
          expectedPreviousApplication
        ) {
          expectedPendingBefore = expectedPreviousApplication.afterTarget;
          expectedPendingAfter = await this.#targets.plannedRollbackState(
            proposal,
            expectedPreviousApplication,
          );
        } else {
          expectedPendingBefore = expectedPreviousApplication?.afterTarget ?? null;
          expectedPendingAfter = await this.#targets.plannedAfterState(
            proposal,
            this.#state.pending.beforeTarget,
          );
        }
      }
      const pending = this.#state.pending;
      const mismatches = settle([
        { field: "proposal", holds: proposal !== undefined },
        {
          field: "catalog.candidateDigest",
          holds:
            proposal === undefined ||
            computeCandidateDigest(proposal.candidate) === pending.candidateDigest,
        },
        { field: "expectedAfterTarget", holds: expectedPendingAfter !== null },
        {
          field: "afterTarget",
          holds:
            expectedPendingAfter === null ||
            targetStatesEqual(pending.afterTarget, expectedPendingAfter),
        },
        {
          field: "beforeTarget",
          holds:
            expectedPendingBefore === null ||
            targetStatesEqual(pending.beforeTarget, expectedPendingBefore),
        },
        {
          field: "beforeTarget.key",
          holds: pendingTarget === null || targetKey(pendingTarget) === targetKeyFromState(pending.beforeTarget),
        },
        {
          field: "afterTarget.key",
          holds: pendingTarget === null || targetKey(pendingTarget) === targetKeyFromState(pending.afterTarget),
        },
        {
          field: "catalogRevision",
          holds: revision === pending.catalogRevisionBefore || revision === pending.expectedCatalogRevisionAfter,
        },
        {
          field: "activeProposal",
          holds: revision !== pending.catalogRevisionBefore || activeId === expectedOldActive,
        },
        {
          field: "previousApplication",
          holds: sha256Canonical(pending.previousApplication) === sha256Canonical(expectedPreviousApplication),
        },
        {
          field: "previousApplication.proposalId",
          holds:
            pending.operation !== "reconcile-promoted" ||
            (pending.previousApplication?.proposalId ?? null) === reconcileRestoredId,
        },
      ]);
      if (mismatches.length > 0) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: pending operation '${pending.commandId}' does not match the catalog (${mismatches.join(", ")})`,
        );
      }
    }
    for (const completed of this.#state.completed) {
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
      const command = this.#state.commands.get(completed.commandId);
      const mismatches = settle([
        { field: "proposal", holds: proposal !== undefined },
        {
          field: "catalog.candidateDigest",
          holds:
            proposal === undefined ||
            computeCandidateDigest(proposal.candidate) === completed.candidateDigest,
        },
        {
          field: "catalogRevisionBefore",
          holds: completed.catalogRevisionBefore <= completed.catalogRevisionAfter,
        },
        { field: "catalogRevisionAfter", holds: completed.catalogRevisionAfter <= revision },
        {
          field: "command",
          holds: command !== undefined || context.syntheticCompletionIds.has(completed.commandId),
        },
        {
          field: "audit",
          holds: expectedAuditKind === null || catalogMutationSucceeded === Boolean(matchingAudit),
        },
      ]);
      if (mismatches.length > 0) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: completed operation '${completed.commandId}' does not match the catalog (${mismatches.join(", ")})`,
        );
      }
    }
    for (const command of this.#state.commands.values()) {
      const completed = completedByCommand.get(command.commandId);
      const catalogProposal = proposals.get(command.proposalId);
      const mismatches = settle([
        { field: "completion", holds: completed !== undefined },
        {
          field: "completion.operation",
          holds: completed === undefined || completed.operation === command.operation,
        },
        {
          field: "completion.proposalId",
          holds: completed === undefined || completed.proposalId === command.proposalId,
        },
        { field: "proposal", holds: catalogProposal !== undefined },
        {
          field: "result.proposal",
          holds:
            catalogProposal === undefined ||
            proposalSnapshotMatchesCatalog(command.result.proposal, catalogProposal),
        },
      ]);
      if (mismatches.length > 0) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: command binding '${command.commandId}' has no matching completion (${mismatches.join(", ")})`,
        );
      }
    }
    for (const audit of snapshot.auditRecords) {
      const applicationCommandId = auditCommandId(audit);
      if (applicationCommandId === undefined) continue;
      const completed = completedByCommand.get(applicationCommandId);
      const pending = this.#state.pending;
      const pendingOwnsAudit =
        pending !== null &&
        pending.commandId === applicationCommandId &&
        this.catalogOutcomeMatchesPending(pending, snapshot, revision);
      const mismatches = settle([
        { field: "pendingOrCompletion", holds: pendingOwnsAudit || completed !== undefined },
        {
          field: "completion.proposalId",
          holds: completed === undefined || completed.proposalId === audit.proposalId,
        },
        {
          field: "completion.status",
          holds: completed === undefined || ["applied", "rolled-back"].includes(completed.status),
        },
      ]);
      if (mismatches.length > 0) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: catalog audit for command '${applicationCommandId}' has no successful application result (${mismatches.join(", ")})`,
        );
      }
    }
  }

  async reconcilePendingOnOpen(): Promise<void> {
    const pending = this.#state.pending;
    if (!pending) return;
    const proposal = this.#catalog.getProposal(pending.proposalId);
    if (!proposal) return this.requireRecovery();
    if (proposal.candidate.kind === "role-prompt") {
      await this.cleanPendingPromptTemps(proposal.candidate.path);
    }
    const state = await this.situationFor(pending, proposal);
    if (!state) return this.requireRecovery();
    await this.settlePending(pending, proposal, state);
  }

  /** Dispatch on where the crash left the target and the catalog. */
  async settlePending(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
    state: ReconcileState,
  ): Promise<void> {
    if (state.situation === "aborted") {
      return await this.abortPending(pending, proposal, state.revision, state.liveTarget);
    }
    if (state.situation === "finalize") {
      return await this.completePendingFromLive(
        pending,
        proposal,
        state.revision,
        state.liveTarget,
      );
    }
    if (state.situation === "finish") {
      return await this.finishCatalogMutation(pending, proposal, state.revision, state.liveTarget);
    }
    this.requireRecovery();
  }

  /** Where the crash left the target and the catalog, or nothing when unsure. */
  async situationFor(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
  ): Promise<ReconcileState | undefined> {
    let liveTarget: TargetDigestState;
    try {
      liveTarget = await this.#targets.readTargetState(proposal.candidate);
    } catch {
      return undefined;
    }
    const { revision, snapshot } = await this.#catalog.readSnapshot();
    const targetIsOld = targetStatesEqual(liveTarget, pending.beforeTarget);
    const targetIsNew = targetStatesEqual(liveTarget, pending.afterTarget);
    const catalogIsOld = revision === pending.catalogRevisionBefore;
    const catalogIsNew = this.catalogOutcomeMatchesPending(pending, snapshot, revision);
    const promptGitApplied =
      proposal.candidate.kind === "role-prompt"
        ? await this.verifyPromptGitOutcome(pending)
        : true;
    const situation = pickSituation({
      targetIsOld,
      targetIsNew,
      catalogIsOld,
      catalogIsNew,
      promptGitApplied,
      candidateKind: proposal.candidate.kind,
    });
    return { situation, liveTarget, revision };
  }

  /** Used by the reconciliation steps: give up and demand operator recovery. */
  requireRecovery(): void {
    this.#state.recoveryRequired = true;
  }

  /** New target, old catalog: finish the catalog mutation idempotently. */
  async finishCatalogMutation(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
    revision: number,
    liveTarget: TargetDigestState,
  ): Promise<void> {
    try {
      if (proposal.candidate.kind === "role-prompt" && !(await this.verifyPromptGitOutcome(pending))) {
        await this.restoreInterruptedPrompt(proposal, pending.beforeTarget);
        await this.finalizePendingAs("aborted", revision, pending.beforeTarget.digest);
        return;
      }
      if (!(await this.applyCatalogForPending(pending, proposal))) return this.requireRecovery();
      const finalProposal = this.#catalog.getProposal(pending.proposalId)!;
      await this.completePendingFromLive(pending, finalProposal, this.#catalog.revision, liveTarget);
    } catch {
      this.requireRecovery();
    }
  }

  /** Promote or roll back as the pending command asked, or report a conflict. */
  async applyCatalogForPending(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
  ): Promise<boolean> {
    if (pending.operation === "reconcile-promoted") return true;
    if (pending.operation === "promote-and-apply") {
      return await this.finishPromotion(pending, proposal);
    }
    if (pending.operation === "rollback-applied") {
      return await this.finishRollback(pending, proposal);
    }
    return false;
  }

  async finishPromotion(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
  ): Promise<boolean> {
    if (proposal.status === "promoted") return true;
    if (proposal.status !== "evaluated") return false;
    const evidence = proposal.evaluation?.evidence;
    if (!evidence) return false;
    await this.#catalog.promote(
      proposal.id,
      evidence,
      pending.humanDecision,
      this.#state.catalogWriter,
      pending.commandId,
    );
    return true;
  }

  async finishRollback(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
  ): Promise<boolean> {
    if (proposal.status === "rolled-back") return true;
    if (proposal.status !== "promoted") return false;
    await this.#catalog.rollback(
      proposal.id,
      pending.humanDecision,
      this.#state.catalogWriter,
      pending.commandId,
    );
    return true;
  }

  /** Old target, old catalog: nothing happened, so mark the command aborted. */
  async abortPending(
    pending: PendingApplicationOperation,
    proposal: EvolutionProposal,
    revision: number,
    liveTarget: TargetDigestState,
  ): Promise<void> {
    if (
      proposal.candidate.kind === "role-prompt" &&
      !(await this.verifyPromptAbortOutcome(pending))
    ) {
      return this.requireRecovery();
    }
    await this.finalizePendingAs("aborted", revision, liveTarget.digest);
  }

  catalogOutcomeMatchesPending(
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

  async verifyPromptGitOutcome(pending: PendingApplicationOperation): Promise<boolean> {
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

  async verifyPromptAbortOutcome(pending: PendingApplicationOperation): Promise<boolean> {
    if (!pending.gitBaseHead || !pending.gitPath) return false;
    return (
      (await this.#git.currentCommit(this.#catalog.root)) === pending.gitBaseHead &&
      (await this.#git.isClean(this.#catalog.root))
    );
  }

  async restoreInterruptedPrompt(
    proposal: EvolutionProposal,
    before: TargetDigestState,
  ): Promise<void> {
    if (proposal.candidate.kind !== "role-prompt" || !before.digest || before.mode === undefined) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Interrupted prompt operation lacks a recoverable before snapshot",
      );
    }
    const bytes = await this.#targets.readPromptObject(before.digest);
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
    const restored = await this.#targets.readTargetState(proposal.candidate);
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

  async cleanPendingPromptTemps(relativePath: string): Promise<void> {
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

  async completePendingFromLive(
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
        this.#state.applications.delete(pending.previousActiveProposalId);
      }
      if (pending.operation === "reconcile-promoted" && pending.previousApplication) {
        this.#state.applications.delete(pending.previousApplication.proposalId);
      }
      this.#state.applications.set(pending.proposalId, {
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
      this.#state.applications.delete(pending.proposalId);
      const restoredId = pending.previousApplication?.previousApplication?.proposalId;
      const catalogRestoredId = this.#catalog.getActiveProposalId(
        targetFromCandidate(proposal.candidate),
      );
      if ((restoredId ?? null) !== catalogRestoredId) {
        this.#state.recoveryRequired = true;
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          "Recovered application predecessor does not match the catalog active pointer",
        );
      }
      if (restoredId) {
        this.#state.applications.set(restoredId, pending.previousApplication!.previousApplication!);
      }
    }

    const status: ApplicationStatus =
      pending.operation === "rollback-applied"
        ? "rolled-back"
        : pending.operation === "reconcile-promoted"
          ? "applied"
          : "applied";

    this.#state.completed.push({
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

    if (!this.#state.commands.has(pending.commandId)) {
      this.#state.commands.set(pending.commandId, {
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

    this.#state.pending = null;
    this.#state.recoveryRequired = false;
    await this.persist(this.#state.revision + 1);
  }

  async finalizePendingAs(
    status: "aborted",
    catalogRevision: number,
    afterDigest: string | null,
  ): Promise<void> {
    const pending = this.#state.pending;
    if (!pending) return;
    this.dropSyntheticPredecessor(pending);
    this.#state.completed.push({
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
    this.rememberCommand(pending, catalogRevision, afterDigest);
    this.#state.pending = null;
    this.#state.recoveryRequired = false;
    await this.persist(this.#state.revision + 1);
  }

  /** A legacy synthetic predecessor leaves no trace once it is settled. */
  dropSyntheticPredecessor(pending: PendingApplicationOperation): void {
    const id = pending.previousApplication?.commandId;
    if (pending.operation !== "reconcile-promoted" || !id?.startsWith("legacy:")) return;
    if (this.#state.commands.has(id)) return;
    const seen = [...this.#state.applications.values()].some((application) =>
      applicationHistoryHasCommand(application, id),
    );
    if (seen) return;
    this.#state.completed = this.#state.completed.filter((record) => record.commandId !== id);
  }

  /** Record the completed command so a replay binds it to its result. */
  rememberCommand(
    pending: PendingApplicationOperation,
    catalogRevision: number,
    afterDigest: string | null,
  ): void {
    const proposal = this.#catalog.getProposal(pending.proposalId);
    if (!proposal || this.#state.commands.has(pending.commandId)) return;
    {
      this.#state.commands.set(pending.commandId, {
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
  }

  async persist(nextRevision: number): Promise<void> {
    if (nextRevision !== this.#state.revision + 1) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Application state revision must advance by exactly one",
      );
    }
    const payload = this.validatedPayload();
    const document: ApplicationDocument = {
      version: EVOLUTION_APPLICATION_DOCUMENT_VERSION,
      revision: nextRevision,
      payloadDigest: computePayloadDigest(payload),
      payload,
    };
    await this.writeDocument(`${JSON.stringify(document)}\n`, nextRevision);
  }

  /** The in-memory state, validated: persisting an invalid state demands recovery. */
  validatedPayload(): ApplicationPayload {
    const candidatePayload: ApplicationPayload = {
      applications: [...this.#state.applications.values()].sort((a, b) =>
        a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0,
      ),
      pending: this.#state.pending,
      completed: [...this.#state.completed],
      commands: [...this.#state.commands.values()].sort((a, b) =>
        a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0,
      ),
      recoveryRequired: this.#state.recoveryRequired,
    };
    const validated = applicationPayloadSchema.safeParse(candidatePayload);
    if (validated.success) return isolate(validated.data) as ApplicationPayload;
    this.#state.recoveryRequired = true;
    this.#state.opened = false;
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new EvolutionApplicationError(
      "RECOVERY_REQUIRED",
      `Refusing to persist invalid application state: ${issues}`,
    );
  }

  /** Write through a temporary file, then rename and fsync the directory. */
  async writeDocument(serialized: string, nextRevision: number): Promise<void> {
    const temporaryPath = `${this.#applicationFilePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await this.writeTemporary(serialized, temporaryPath);
      await this.#io.rename(temporaryPath, this.#applicationFilePath);
      await this.commitAfterRename(serialized, nextRevision);
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      this.#state.recoveryRequired = true;
      this.#state.opened = false;
      throw this.persistError(error);
    }
  }

  async writeTemporary(serialized: string, temporaryPath: string): Promise<void> {
    await assertSafeRegularFileOrMissing(this.#io, this.#catalog.root, this.#applicationFilePath);
    const handle = await this.#io.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await this.#io.chmod(temporaryPath, 0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async commitAfterRename(serialized: string, nextRevision: number): Promise<void> {
    try {
      await this.#io.syncDirectory(this.#evolutionDirectory);
    } catch (error) {
      this.#state.recoveryRequired = true;
      throw new RenameCompletedButSyncFailed(error);
    }
    this.#state.revision = nextRevision;
    this.#state.persistedContents = serialized;
    this.publishCommittedState();
  }

  persistError(error: unknown): EvolutionApplicationError {
    if (error instanceof RenameCompletedButSyncFailed) {
      return new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Application state rename completed but directory fsync failed: ${
          error.cause instanceof Error ? error.cause.message : String(error.cause)
        }`,
      );
    }
    return new EvolutionApplicationError(
      "RECOVERY_REQUIRED",
      `Failed to persist application state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }


  publishCommittedState(): void {
    this.#state.publishedState = isolate({
      revision: this.#state.revision,
      applications: [...this.#state.applications.values()].sort((a, b) =>
        a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0,
      ),
      pending: this.#state.pending,
      completed: [...this.#state.completed],
      recoveryRequired: this.#state.recoveryRequired,
    });
  }
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

function parseApplicationDocument(
  text: string,
  filePath: string,
): { revision: number; payload: ApplicationPayload } {
  assertDocumentSize(text, filePath);
  const record = asDocument(parseJson(text, filePath), filePath);
  assertDocumentKeys(record, filePath);
  const payloadRecord = asPayload(record, filePath);
  assertPayloadDepth(payloadRecord, filePath);
  assertDigest(record, payloadRecord, filePath);
  const payload = parsePayload(payloadRecord, filePath);
  assertUniqueness(payload, filePath);
  validateBindings(payload, filePath);
  return { revision: record.revision as number, payload: isolate(payload) as ApplicationPayload };
}

function invalid(filePath: string, detail: string): EvolutionPersistenceValidationError {
  return new EvolutionPersistenceValidationError(`Invalid application state at ${filePath}: ${detail}`);
}

function assertDocumentSize(text: string, filePath: string): void {
  if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) {
    throw invalid(filePath, "document exceeds 16 MiB");
  }
}

function parseJson(text: string, filePath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid(filePath, "malformed JSON");
  }
}

function asDocument(document: unknown, filePath: string): Record<string, unknown> {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalid(filePath, "expected object document");
  }
  return document as Record<string, unknown>;
}

/** Version, revision and digest are the header every document must carry. */
function assertDocumentKeys(record: Record<string, unknown>, filePath: string): void {
  assertExactKeys(
    record,
    ["version", "revision", "payloadDigest", "payload"],
    `application state at ${filePath}`,
  );
  for (const check of DOCUMENT_CHECKS) {
    if (!check.holds(record)) throw invalid(filePath, check.detail);
  }
}

/** Every header rule names the value it protects. */
const DOCUMENT_CHECKS: Array<{ holds(record: Record<string, unknown>): boolean; detail: string }> = [
  {
    holds: (record) => record.version === EVOLUTION_APPLICATION_DOCUMENT_VERSION,
    detail: "unsupported version",
  },
  {
    holds: (record) =>
      typeof record.revision === "number" &&
      Number.isSafeInteger(record.revision) &&
      record.revision >= 1,
    detail: "revision must be a positive safe integer",
  },
  {
    holds: (record) =>
      typeof record.payloadDigest === "string" && /^[a-f0-9]{64}$/.test(record.payloadDigest),
    detail: "payloadDigest must be lowercase SHA-256 hex",
  },
];

function asPayload(record: Record<string, unknown>, filePath: string): Record<string, unknown> {
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw invalid(filePath, "payload must be an object");
  }
  const payloadRecord = record.payload as Record<string, unknown>;
  assertExactKeys(
    payloadRecord,
    ["applications", "pending", "completed", "commands", "recoveryRequired"],
    `application state payload at ${filePath}`,
  );
  return payloadRecord;
}

function assertPayloadDepth(payloadRecord: Record<string, unknown>, filePath: string): void {
  assertJsonNestingDepth(payloadRecord, filePath);
  assertRawApplicationHistoryDepth(payloadRecord, filePath);
}

function assertDigest(
  record: Record<string, unknown>,
  payloadRecord: Record<string, unknown>,
  filePath: string,
): void {
  if (computePayloadDigest(payloadRecord) !== record.payloadDigest) {
    throw invalid(filePath, "payload digest mismatch");
  }
}

function parsePayload(payloadRecord: Record<string, unknown>, filePath: string): ApplicationPayload {
  const parsed = applicationPayloadSchema.safeParse(payloadRecord);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
    .join("; ");
  throw invalid(filePath, issues);
}

function assertUniqueness(payload: ApplicationPayload, filePath: string): void {
  assertUniqueBy(payload.applications, (item) => item.proposalId, "application proposalId", filePath);
  assertUniqueBy(payload.applications, (item) => targetKey(item.target), "active application target", filePath);
  assertUniqueBy(payload.completed, (item) => item.commandId, "completed commandId", filePath);
  assertUniqueBy(payload.commands, (item) => item.commandId, "idempotency commandId", filePath);
}

/** Every command must be completed exactly as recorded, and none twice. */
function validateBindings(payload: ApplicationPayload, filePath: string): void {
  for (const application of payload.applications) validateApplicationRecord(application, filePath);
  for (const command of payload.commands) assertCommandBinding(payload, command, filePath);
  assertNoPendingCollision(payload, filePath);
}

function assertCommandBinding(
  payload: ApplicationPayload,
  command: ApplicationPayload["commands"][number],
  filePath: string,
): void {
  const completed = payload.completed.find((record) => record.commandId === command.commandId);
  if (bindingMatches(command, completed)) return;
  throw invalid(filePath, `command '${command.commandId}' result binding mismatch`);
}

/** Every recorded field must echo the command it answers. */
function bindingMatches(
  command: ApplicationPayload["commands"][number],
  completed: ApplicationPayload["completed"][number] | undefined,
): boolean {
  if (!completed) return false;
  return BINDING_FIELDS.every((field) => field.matches(command, completed));
}

const BINDING_FIELDS: Array<{
  matches(
    command: ApplicationPayload["commands"][number],
    completed: ApplicationPayload["completed"][number],
  ): boolean;
}> = [
  { matches: (command) => command.result.proposal.id === command.proposalId },
  {
    matches: (command) =>
      computeCandidateDigest(command.result.proposal.candidate) === command.candidateDigest,
  },
  { matches: (command, completed) => completed.operation === command.operation },
  { matches: (command, completed) => completed.proposalId === command.proposalId },
  { matches: (command, completed) => completed.candidateDigest === command.candidateDigest },
  { matches: (command, completed) => completed.operator === command.operator },
  { matches: (command, completed) => completed.reason === command.reason },
  { matches: (command, completed) => completed.catalogRevisionBefore === command.expectedRevision },
  {
    matches: (command, completed) =>
      completed.catalogRevisionAfter === command.result.committedCatalogRevision,
  },
  { matches: (command, completed) => completed.status === command.result.applicationStatus },
  {
    matches: (command, completed) =>
      completed.beforeTargetDigest === command.result.beforeTargetDigest,
  },
  {
    matches: (command, completed) =>
      completed.afterTargetDigest === command.result.afterTargetDigest,
  },
  { matches: (command, completed) => completed.humanDecision.actor === command.operator },
  { matches: (command, completed) => completed.humanDecision.reason === command.reason },
];

function assertNoPendingCollision(payload: ApplicationPayload, filePath: string): void {
  const pending = payload.pending;
  if (!pending) return;
  const clashes =
    payload.commands.some((item) => item.commandId === pending.commandId) ||
    payload.completed.some((item) => item.commandId === pending.commandId);
  if (clashes) throw invalid(filePath, "pending commandId is already completed");
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

/** Applications plus any pending predecessor are the history entry points. */
function historyRoots(payload: Record<string, unknown>): unknown[] {
  const roots: unknown[] = Array.isArray(payload.applications) ? [...payload.applications] : [];
  const pending = payload.pending;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) {
    roots.push((pending as Record<string, unknown>).previousApplication);
  }
  return roots;
}

function assertRawApplicationHistoryDepth(
  payload: Record<string, unknown>,
  filePath: string,
): void {
  const roots = historyRoots(payload);
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
    throw invalid(filePath, "application history is too deep");
  }
  assertTargetBinding(application, filePath);
  assertHistoryBinding(application, filePath);
  if (application.previousApplication) {
    validateApplicationRecord(application.previousApplication, filePath, depth + 1);
  }
}

/** The digests and targets must agree with the state each side claims. */
function assertTargetBinding(application: ApplicationRecord, filePath: string): void {
  const key = targetKey(application.target);
  const matches =
    application.beforeTargetDigest === application.beforeTarget.digest &&
    application.afterTargetDigest === application.afterTarget.digest &&
    key === targetKeyFromState(application.afterTarget) &&
    targetKeyFromState(application.beforeTarget) === key;
  if (!matches) {
    throw invalid(filePath, `application '${application.proposalId}' target binding mismatch`);
  }
}

/** A history entry must describe the state its successor started from. */
function assertHistoryBinding(application: ApplicationRecord, filePath: string): void {
  const previous = application.previousApplication;
  if (!previous) return;
  const matches =
    targetKey(previous.target) === targetKey(application.target) &&
    previous.afterTargetDigest === application.beforeTargetDigest;
  if (!matches) {
    throw invalid(filePath, `application '${application.proposalId}' history mismatch`);
  }
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
