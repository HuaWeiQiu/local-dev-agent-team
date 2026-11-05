import path from "node:path";
import { clearPromptTemplateCache } from "../agents/service.js";
import { type GitManager } from "../git/manager.js";
import type { EvolutionCandidateTarget, EvolutionCatalogSnapshot } from "./catalog.js";
import {
  computeCandidateDigest,
  type EvolutionProposal,
  type HumanDecision,
  type AuditRecord,
  type PromotionRecord,
  type RollbackRecord,
} from "./domain.js";
import {
  computePayloadDigest,
  type DurableEvolutionCatalog,
  EvolutionPersistenceValidationError,
} from "./persistence.js";
import { applicationPayloadSchema } from "./application-schemas.js";
import { promptTempName, promptTempPattern, siblingTempName } from "./temp-names.js";
import {
  EVOLUTION_APPLICATION_DOCUMENT_VERSION,
  EvolutionApplicationError,
  MAX_APPLICATION_HISTORY_DEPTH,
  applicationHistoryHasCommand,
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
/**
 * The extra requirement each operation puts on its proof, as rows: a field name and a
 * predicate. Adding an operation adds rows; it never adds a branch to `operationChecks`.
 */
const OPERATION_PROOF_CHECKS: Record<
  string,
  Array<{ field: string; requires: (input: ProofInput) => boolean }>
> = {
  "promote-and-apply": [
    { field: "command", requires: (input) => input.command !== undefined },
    {
      field: "command.operation",
      requires: (input) =>
        input.command === undefined || input.command.operation === "promote-and-apply",
    },
    { field: "application.rollbackSafe", requires: (input) => input.application.rollbackSafe },
    { field: "application.status", requires: (input) => input.application.status === "applied" },
  ],
  "reconcile-promoted": [
    {
      field: "completion.status",
      requires: (input) => input.completion?.status === input.application.status,
    },
    {
      field: "command.operation",
      requires: (input) =>
        input.command === undefined || input.command.operation === "reconcile-promoted",
    },
    {
      field: "application.status",
      requires: (input) => input.command === undefined || input.reconcileStatusMatches,
    },
    {
      field: "application.rollbackSafe",
      requires: (input) => input.application.rollbackSafe === input.reconcileRollbackSafe,
    },
    {
      field: "syntheticLegacyBaseline",
      requires: (input) =>
        input.command !== undefined ||
        (input.syntheticLegacyBaseline && COMMAND_FALLBACK["reconcile-promoted"] !== null),
    },
  ],
};

/** The rows for this operation, evaluated. Nothing here branches on the operation itself. */
function operationChecks(input: ProofInput): Array<{ field: string; holds: boolean }> {
  const rows =
    input.completion === undefined ? [] : (OPERATION_PROOF_CHECKS[input.completion.operation] ?? []);
  return rows.map((row) => ({ field: row.field, holds: row.requires(input) }));
}

type Pair = [string, Record<string, unknown> | undefined, Record<string, unknown>];

/** A completion must always agree, so a missing one is a row with nothing to compare. */
function completionPairs(input: ProofInput): Pair[] {
  const { application, completion } = input;
  return completion === undefined
    ? [["completion", undefined, {}]]
    : [["completion", completionView(completion), applicationCompletionView(application)]];
}

/** A missing command is the legacy Phase-2 shape, so it contributes no row at all. */
function commandPairs(input: ProofInput): Pair[] {
  const { application, command } = input;
  return command === undefined
    ? []
    : [["command", commandView(command), applicationCommandView(application)]];
}

/** Every field the pairs disagree about, named `record.field`. */
function pairMismatches(pairs: Pair[]): string[] {
  const failed: string[] = [];
  for (const [name, actual, expected] of pairs) {
    if (actual === undefined) {
      failed.push(name);
      continue;
    }
    failed.push(...prefixed(name, mismatchedFields(actual, expected)));
  }
  return failed;
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
 * The pending record together with everything the catalog says about it.
 *
 * Resolved once, then read by the check groups below — each group answers one question (does
 * the shape hold, do the target states match, does the revision agree, does the replaced
 * application line up). When they were one eleven-row table, a mismatch told the reader the
 * field name but not which *expectation* had been derived wrongly.
 */
type PendingExpectation = {
  pending: PendingApplicationOperation;
  revision: number;
  proposal: EvolutionProposal | undefined;
  /** The target this operation was recorded against, when the catalog still has its candidate. */
  pendingTarget: EvolutionCandidateTarget | null;
  /** The catalog's active proposal for that target right now. */
  activeId: string | null;
  activeBefore: string | null;
  expectedPreviousApplication: ApplicationRecord | null;
  reconcileRestoredId: string | null | undefined;
  /** What the target should look like before and after, planned from the catalog. */
  before: TargetDigestState | null;
  after: TargetDigestState | null;
};

/** The proposal the pending record names must still exist, and still digest the same. */
function pendingShapeMismatches(expectation: PendingExpectation): string[] {
  const { pending, proposal } = expectation;
  return settle([
    { field: "proposal", holds: proposal !== undefined },
    {
      field: "catalog.candidateDigest",
      holds:
        proposal === undefined ||
        computeCandidateDigest(proposal.candidate) === pending.candidateDigest,
    },
  ]);
}

/** Both recorded target states must match the plan — or there was nothing to compare against. */
function pendingTargetMismatches(expectation: PendingExpectation): string[] {
  const { pending, before, after } = expectation;
  return settle([
    { field: "expectedAfterTarget", holds: after !== null },
    { field: "afterTarget", holds: after === null || targetStatesEqual(pending.afterTarget, after) },
    {
      field: "beforeTarget",
      holds: before === null || targetStatesEqual(pending.beforeTarget, before),
    },
  ]);
}

/** Neither recorded target may name a different target than the candidate being applied. */
function pendingTargetKeyMismatches(expectation: PendingExpectation): string[] {
  const { pending, pendingTarget } = expectation;
  return settle([
    {
      field: "beforeTarget.key",
      holds:
        pendingTarget === null || targetKey(pendingTarget) === targetKeyFromState(pending.beforeTarget),
    },
    {
      field: "afterTarget.key",
      holds:
        pendingTarget === null || targetKey(pendingTarget) === targetKeyFromState(pending.afterTarget),
    },
  ]);
}

/** The revision must be one the operation can be at, and the active pointer must agree with it. */
function pendingRevisionMismatches(expectation: PendingExpectation): string[] {
  const { pending, revision, activeId, activeBefore } = expectation;
  return settle([
    {
      field: "catalogRevision",
      holds:
        revision === pending.catalogRevisionBefore ||
        revision === pending.expectedCatalogRevisionAfter,
    },
    {
      field: "activeProposal",
      holds: revision !== pending.catalogRevisionBefore || activeId === activeBefore,
    },
  ]);
}

/** The application this operation replaces, and — for a reconciliation — the id it restores. */
function pendingPreviousApplicationMismatches(expectation: PendingExpectation): string[] {
  const { pending, expectedPreviousApplication, reconcileRestoredId } = expectation;
  return settle([
    {
      field: "previousApplication",
      holds:
        sha256Canonical(pending.previousApplication) ===
        sha256Canonical(expectedPreviousApplication),
    },
    {
      field: "previousApplication.proposalId",
      holds:
        pending.operation !== "reconcile-promoted" ||
        (pending.previousApplication?.proposalId ?? null) === reconcileRestoredId,
    },
  ]);
}

/**
 * The audit kinds that can name an application command. Rejections, archives and deletions are
 * lifecycle audit records with nothing applied behind them, so they never belong to a
 * completion — narrowing here is what lets the predicates below read `applicationCommandId`.
 */
type ApplicationAuditRecord = Exclude<
  AuditRecord,
  { kind: "rejection" | "archive" | "unarchive" | "delete" }
>;

/**
 * A completed record together with what the catalog says it should have left behind.
 *
 * Split out of the eleven-line check the same way `PendingExpectation` is: the audit lookup
 * alone carried a six-conjunct predicate, and folding it into the comparison hid the
 * difference between "no audit matched" and "an audit matched but disagrees".
 */
type CompletedExpectation = {
  completed: CompletedApplicationRecord;
  revision: number;
  proposal: EvolutionProposal | undefined;
  command: CommandIdempotencyBinding | undefined;
  /** The audit kind this operation must produce, or null when it produces none. */
  expectedAuditKind: "promotion" | "rollback" | null;
  matchingAudit: ApplicationAuditRecord | undefined;
  /** Whether the completion claims the catalog was actually mutated. */
  catalogMutationSucceeded: boolean;
  /** Whether this id is vouched for by a captured legacy baseline rather than a command. */
  syntheticCompletion: boolean;
};

/**
 * Whether the audit names this completion's command.
 *
 * An audit with no command id is a legacy Phase-2 record: it predates the journal, so the
 * absence is only acceptable for a completion that never claimed a mutation.
 */
function auditNamesCompletion(
  audit: ApplicationAuditRecord,
  completed: CompletedApplicationRecord,
): boolean {
  if (audit.applicationCommandId === completed.commandId) return true;
  return audit.applicationCommandId === undefined && completed.status !== "aborted";
}

/** Whether the audit describes this completion's decision, never mind which command it names. */
function auditDescribesDecision(
  audit: ApplicationAuditRecord,
  completed: CompletedApplicationRecord,
): boolean {
  return (
    audit.proposalId === completed.proposalId &&
    audit.actor === completed.humanDecision.actor &&
    audit.reason === completed.humanDecision.reason &&
    audit.at === completed.humanDecision.decidedAt &&
    auditNamesCompletion(audit, completed)
  );
}

/** The first audit of the expected kind that describes this completion's decision. */
function matchingCompletionAudit(
  context: RestoredStateContext,
  completed: CompletedApplicationRecord,
  expectedAuditKind: "promotion" | "rollback" | null,
): ApplicationAuditRecord | undefined {
  if (expectedAuditKind === null) return undefined;
  const kind = expectedAuditKind;
  return context.snapshot.auditRecords.find(
    (record): record is ApplicationAuditRecord =>
      record.kind === kind && auditDescribesDecision(record, completed),
  );
}

/** The proposal the completed record names must still exist, and still digest the same. */
function completedShapeMismatches(expectation: CompletedExpectation): string[] {
  const { completed, proposal } = expectation;
  return settle([
    { field: "proposal", holds: proposal !== undefined },
    {
      field: "catalog.candidateDigest",
      holds:
        proposal === undefined ||
        computeCandidateDigest(proposal.candidate) === completed.candidateDigest,
    },
  ]);
}

/** The revisions must bracket each other and never overtake the catalog's own revision. */
function completedRevisionMismatches(expectation: CompletedExpectation): string[] {
  const { completed, revision } = expectation;
  return settle([
    {
      field: "catalogRevisionBefore",
      holds: completed.catalogRevisionBefore <= completed.catalogRevisionAfter,
    },
    { field: "catalogRevisionAfter", holds: completed.catalogRevisionAfter <= revision },
  ]);
}

/** The binding and the audit both have to exist — or be legitimately absent. */
function completedOwnershipMismatches(expectation: CompletedExpectation): string[] {
  const { command, expectedAuditKind, matchingAudit, catalogMutationSucceeded, syntheticCompletion } =
    expectation;
  return settle([
    { field: "command", holds: command !== undefined || syntheticCompletion },
    {
      field: "audit",
      holds: expectedAuditKind === null || catalogMutationSucceeded === Boolean(matchingAudit),
    },
  ]);
}

/**
 * Which catalog audit records a completion must have left behind. A table rather than a
 * nested ternary: adding an operation means adding a row, and an operation with no audit
 * (a reconciliation) is visibly the absence of a row rather than a fall-through.
 */
const AUDIT_KIND_BY_OPERATION: Record<string, "promotion" | "rollback" | undefined> = {
  "promote-and-apply": "promotion",
  "rollback-applied": "rollback",
};

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

/** A command that could own a synthetic legacy predecessor. */
type SyntheticOwner = {
  commandId: string;
  proposalId: string;
  reason: string;
  humanDecision: HumanDecision;
};

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
    const syntheticOwner = this.syntheticOwnerFor(application, input, parentCommandId);
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
    const { application } = input;
    // The pairs are generated by their own functions: a record that must agree contributes
    // one row, and a record that may legitimately be absent contributes none.
    const mismatches = [
      ...pairMismatches(completionPairs(input)),
      ...pairMismatches(commandPairs(input)),
    ];
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
          input.command !== undefined ||
          input.completion === undefined ||
          input.completion.catalogRevisionBefore === application.catalogRevision,
      },
      ...operationChecks(input),
    ];
    mismatches.push(...settle(checks));
    return [...new Set(mismatches)];
  }

  /**
   * What the state around a pending operation is supposed to look like. Kept apart from the
   * comparison that uses it so a wrong *expectation* and a wrong *comparison* fail in
   * different places: both used to live in one function, and a mismatch never said which of
   * the two had gone wrong.
   */
  private async pendingExpectation(
    pending: PendingApplicationOperation,
    context: RestoredStateContext,
  ): Promise<{
    expectedOldActive: string | null;
    expectedPreviousApplication: ApplicationRecord | null;
    reconcileRestoredId: string | null | undefined;
  }> {
    const expectedOldActive =
      pending.operation === "promote-and-apply"
        ? pending.previousActiveProposalId
        : pending.proposalId;
    const expectedPreviousApplication = this.pendingPreviousApplication(pending);
    if (pending.operation !== "reconcile-promoted") {
      return { expectedOldActive, expectedPreviousApplication, reconcileRestoredId: undefined };
    }
    const reconcileRestoredId = (
      await this.#catalog.preflightRollback(pending.proposalId, pending.humanDecision)
    ).record.restoredActiveProposalId;
    if (pending.previousApplication) {
      await this.validateApplicationProof(pending.previousApplication, context, pending.commandId);
    }
    return { expectedOldActive, expectedPreviousApplication, reconcileRestoredId };
  }

  /** The application a pending operation replaces, if it replaces one. */
  private pendingPreviousApplication(pending: PendingApplicationOperation): ApplicationRecord | null {
    if (pending.operation === "promote-and-apply") {
      return pending.previousActiveProposalId
        ? (this.#state.applications.get(pending.previousActiveProposalId) ?? null)
        : null;
    }
    if (pending.operation === "rollback-applied") {
      return this.#state.applications.get(pending.proposalId) ?? null;
    }
    return pending.previousApplication;
  }

  /**
   * The command that could have produced this "synthetic" legacy predecessor, if any.
   *
   * A legacy Phase-2 promotion was applied before the journal existed, so reconciliation
   * records a predecessor whose command id is derived from the owner rather than stored.
   * Finding that owner is its own question, asked only for records without a command.
   */
  private syntheticOwnerFor(
    application: ApplicationRecord,
    context: RestoredStateContext,
    parentCommandId: string | null,
  ): SyntheticOwner | undefined {
    const owners = [
      ...this.pendingSyntheticOwners(parentCommandId),
      ...this.completedSyntheticOwners(context, parentCommandId),
    ];
    return owners.find((owner) => this.ownerDerivedTheApplication(owner, application, context));
  }

  /** The reconciliation still pending, when it is the owner the caller is asking about. */
  private pendingSyntheticOwners(parentCommandId: string | null): SyntheticOwner[] {
    const pending = this.#state.pending;
    if (pending === null) return [];
    if (pending.operation !== "reconcile-promoted") return [];
    if (parentCommandId !== pending.commandId) return [];
    return [
      {
        commandId: pending.commandId,
        proposalId: pending.proposalId,
        reason: pending.reason,
        humanDecision: pending.humanDecision,
      },
    ];
  }

  /** Every completed reconciliation that could be the owner, narrowed by the parent command. */
  private completedSyntheticOwners(
    context: RestoredStateContext,
    parentCommandId: string | null,
  ): SyntheticOwner[] {
    const owners: SyntheticOwner[] = [];
    for (const command of this.#state.commands.values()) {
      if (command.operation !== "reconcile-promoted") continue;
      if (parentCommandId !== null && command.commandId !== parentCommandId) continue;
      const completion = context.completedByCommand.get(command.commandId);
      if (completion === undefined) continue;
      owners.push({
        commandId: command.commandId,
        proposalId: command.proposalId,
        reason: command.reason,
        humanDecision: completion.humanDecision,
      });
    }
    return owners;
  }

  /** Whether this owner's derived command id and promotion chain explain the application. */
  private ownerDerivedTheApplication(
    owner: { commandId: string; proposalId: string },
    application: ApplicationRecord,
    context: RestoredStateContext,
  ): boolean {
    const ownerPromotion = context.promotionByProposal.get(owner.proposalId);
    const expectedCommandId = `legacy:${sha256Canonical({
      commandId: owner.commandId,
      proposalId: application.proposalId,
      target: application.afterTarget,
    })}`;
    return (
      ownerPromotion?.previousActiveProposalId === application.proposalId &&
      expectedCommandId === application.commandId
    );
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
    await this.validateApplicationEntries(context);
    await this.validatePendingEntry(context);
    await this.validateCompletedEntries(context);
    await this.validateCommandBindings(context);
    await this.validateAuditOwnership(context);
  }

  /** Every recorded application proof, and the active target it claims. */
  async validateApplicationEntries(context: RestoredStateContext): Promise<void> {
    for (const application of this.#state.applications.values()) {
      await this.validateApplicationProof(application, context);
      this.assertApplicationIsActive(application, context);
    }
  }

  /** The proof must be for the proposal the catalog currently has in effect for its target. */
  assertApplicationIsActive(application: ApplicationRecord, context: RestoredStateContext): void {
    const activeId = context.activeByTarget.get(targetKey(application.target));
    if (!this.applicationIsInEffect(application, activeId, context)) {
      throw new EvolutionPersistenceValidationError(
        `Invalid application state: '${application.proposalId}' is not the catalog active proposal`,
      );
    }
  }

  /**
   * Whether the catalog can still be read as "this proposal is the one in effect".
   *
   * Two ways that can be true, and they answer different questions: the active pointer never
   * moved off it, or a rollback is pending and has not committed the pointer back yet. Neither
   * is a licence to accept an arbitrary proof — see `ownerDerivedTheApplication` for the case
   * where a legacy predecessor has no pointer at all.
   */
  private applicationIsInEffect(
    application: ApplicationRecord,
    activeId: string | undefined,
    context: RestoredStateContext,
  ): boolean {
    return (
      this.activePointerCarriedForward(application, activeId, context) ||
      this.pendingRollbackExplainsActive(application, context)
    );
  }

  /**
   * The pointer is still this proposal, or the proposal the pointer names replaced it — a
   * promotion records `previousActiveProposalId`, so a pointer that moved *forward* still
   * explains the proof it left behind. No pointer at all explains nothing.
   */
  private activePointerCarriedForward(
    application: ApplicationRecord,
    activeId: string | undefined,
    context: RestoredStateContext,
  ): boolean {
    if (activeId === undefined) return false;
    if (activeId === application.proposalId) return true;
    return context.promotionByProposal.get(activeId)?.previousActiveProposalId === application.proposalId;
  }

  /**
   * A rollback that has been applied but not yet committed leaves the active pointer on the
   * proposed target, so the proof it is about to replace is legitimately "not active" until the
   * catalog catches up. Every part of the pending record has to line up, including the catalog
   * outcome, otherwise this would excuse any proof at all.
   */
  private pendingRollbackExplainsActive(
    application: ApplicationRecord,
    context: RestoredStateContext,
  ): boolean {
    const pending = this.#state.pending;
    if (pending === null || pending.operation !== "rollback-applied") return false;
    if (pending.proposalId !== application.proposalId) return false;
    if (context.revision !== pending.expectedCatalogRevisionAfter) return false;
    return this.catalogOutcomeMatchesPending(pending, context.snapshot, context.revision);
  }


  /** The pending operation, and the expectation computed from the current state. */
  async validatePendingEntry(context: RestoredStateContext): Promise<void> {
    const pending = this.#state.pending;
    if (pending === null) return;
    const expectation = await this.pendingExpectationFrom(pending, context);
    const mismatches = [
      ...pendingShapeMismatches(expectation),
      ...pendingTargetMismatches(expectation),
      ...pendingTargetKeyMismatches(expectation),
      ...pendingRevisionMismatches(expectation),
      ...pendingPreviousApplicationMismatches(expectation),
    ];
    if (mismatches.length > 0) {
      throw new EvolutionPersistenceValidationError(
        `Invalid application state: pending operation '${pending.commandId}' does not match the catalog (${mismatches.join(", ")})`,
      );
    }
  }

  /**
   * Resolve everything the pending checks compare against, once.
   *
   * The four check groups below are separate functions over this one bag so each reads as a
   * small table of fields. They were one eleven-row table, which made "which expectation was
   * wrong" and "which comparison was wrong" impossible to tell apart from the message alone.
   */
  private async pendingExpectationFrom(
    pending: PendingApplicationOperation,
    context: RestoredStateContext,
  ): Promise<PendingExpectation> {
    const proposal = context.proposals.get(pending.proposalId);
    const pendingTarget = proposal ? targetFromCandidate(proposal.candidate) : null;
    const activeId = pendingTarget
      ? (context.activeByTarget.get(targetKey(pendingTarget)) ?? null)
      : null;
    const { expectedOldActive, expectedPreviousApplication, reconcileRestoredId } =
      await this.pendingExpectation(pending, context);
    const planned = proposal
      ? await this.plannedPendingStates(proposal, pending, expectedPreviousApplication)
      : { before: null, after: null };
    return {
      pending,
      revision: context.revision,
      proposal,
      pendingTarget,
      activeId,
      activeBefore: expectedOldActive,
      expectedPreviousApplication,
      reconcileRestoredId,
      before: planned.before,
      after: planned.after,
    };
  }

  /**
   * What the target should look like before and after this pending operation.
   *
   * A rollback that is already applied is compared against the state the *previous* application
   * left, not against the current target: the catalog has not moved back yet. Everything else is
   * planned forward from the bytes the operation recorded before it touched anything.
   */
  private async plannedPendingStates(
    proposal: EvolutionProposal,
    pending: PendingApplicationOperation,
    expectedPreviousApplication: ApplicationRecord | null,
  ): Promise<{ before: TargetDigestState | null; after: TargetDigestState | null }> {
    if (pending.operation === "rollback-applied" && expectedPreviousApplication) {
      return {
        before: expectedPreviousApplication.afterTarget,
        after: await this.#targets.plannedRollbackState(proposal, expectedPreviousApplication),
      };
    }
    return {
      before: expectedPreviousApplication?.afterTarget ?? null,
      after: await this.#targets.plannedAfterState(proposal, pending.beforeTarget),
    };
  }

  /** Every completed record, and the catalog audit it must have left behind. */
  async validateCompletedEntries(context: RestoredStateContext): Promise<void> {
    for (const completed of this.#state.completed) {
      const expectation = this.completedExpectation(completed, context);
      const mismatches = [
        ...completedShapeMismatches(expectation),
        ...completedRevisionMismatches(expectation),
        ...completedOwnershipMismatches(expectation),
      ];
      if (mismatches.length > 0) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: completed operation '${completed.commandId}' does not match the catalog (${mismatches.join(", ")})`,
        );
      }
    }
  }

  /**
   * Resolve what the catalog says this completion should have left behind, once.
   *
   * The audit lookup used to be an inline ternary holding a six-conjunct predicate, which
   * made "the catalog recorded no matching audit" and "the audit disagrees about who decided"
   * the same `undefined`. They are different states now, and the field names say which.
   */
  private completedExpectation(
    completed: CompletedApplicationRecord,
    context: RestoredStateContext,
  ): CompletedExpectation {
    const expectedAuditKind = AUDIT_KIND_BY_OPERATION[completed.operation] ?? null;
    return {
      completed,
      revision: context.revision,
      proposal: context.proposals.get(completed.proposalId),
      command: this.#state.commands.get(completed.commandId),
      expectedAuditKind,
      matchingAudit: matchingCompletionAudit(context, completed, expectedAuditKind),
      catalogMutationSucceeded:
        completed.status === "applied" || completed.status === "rolled-back",
      syntheticCompletion: context.syntheticCompletionIds.has(completed.commandId),
    };
  }

  /** Every idempotency binding, and the completion it must point at. */
  async validateCommandBindings(context: RestoredStateContext): Promise<void> {
      for (const command of this.#state.commands.values()) {
        const completed = context.completedByCommand.get(command.commandId);
        const catalogProposal = context.proposals.get(command.proposalId);
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
  }

  /** Every catalog audit that names an application command, and who owns it. */
  async validateAuditOwnership(context: RestoredStateContext): Promise<void> {
      for (const audit of context.snapshot.auditRecords) {
        const applicationCommandId = auditCommandId(audit);
        if (applicationCommandId === undefined) continue;
        const completed = context.completedByCommand.get(applicationCommandId);
        const pending = this.#state.pending;
        const pendingOwnsAudit =
          pending !== null &&
          pending.commandId === applicationCommandId &&
          this.catalogOutcomeMatchesPending(pending, context.snapshot, context.revision);
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

  /**
   * Promote the pending command asked for, when the target write already happened.
   *
   * The first two returns are guards, not recovery steps: a recovery never arrives with the
   * catalog already advanced (the situation check routes that case elsewhere), so they only
   * matter for a repeated call. They are deliberately uncovered — see the branch-coverage
   * note in docs/ub-quality-gates.zh-CN.md before "fixing" that.
   */
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

  /** The mirror of `finishPromotion`, with the same two guard returns and the same reason. */
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
      promptTempName(path.basename(absolute), { recovery: true }),
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
    const pattern = promptTempPattern(path.basename(absolute), { allowRecovery: true });
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
    const temporaryPath = siblingTempName(this.#applicationFilePath);
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
