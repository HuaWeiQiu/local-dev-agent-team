import { randomBytes } from "node:crypto";
import path from "node:path";
import { clearPromptTemplateCache } from "../agents/service.js";
import { GitManager } from "../git/manager.js";
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
  DurableEvolutionCatalog,
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
  type ApplicationRecord,
  type ApplicationStatus,
  type EvolutionApplicationFileIo,
  type EvolutionApplicationState,
  type PendingApplicationOperation,
  type TargetDigestState,
} from "./application-shared.js";
import {
  assertSafeRegularFileOrMissing,
  type EvolutionApplicationTargets,
} from "./application-target.js";

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
      await this.#validateRestoredState();
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
      this.#state.completed.map((record) => [record.commandId, record]),
    );
    const syntheticCompletionIds = new Set<string>();
    const validateApplication = async (
      application: ApplicationRecord,
      parentCommandId: string | null = null,
    ): Promise<void> => {
      const proposal = proposals.get(application.proposalId);
      const completion = completedByCommand.get(application.commandId);
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
    for (const application of this.#state.applications.values()) {
      await validateApplication(application);
      const activeId = activeByTarget.get(targetKey(application.target));
      const committedPendingRollback =
        this.#state.pending?.operation === "rollback-applied" &&
        this.#state.pending.proposalId === application.proposalId &&
        revision === this.#state.pending.expectedCatalogRevisionAfter &&
        this.#catalogOutcomeMatchesPending(this.#state.pending, snapshot, revision);
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
          await validateApplication(
            this.#state.pending.previousApplication,
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
      if (
        !proposal ||
        computeCandidateDigest(proposal.candidate) !== this.#state.pending.candidateDigest ||
        !pendingTarget ||
        !expectedPendingAfter ||
        !targetStatesEqual(this.#state.pending.afterTarget, expectedPendingAfter) ||
        (expectedPendingBefore !== null &&
          !targetStatesEqual(this.#state.pending.beforeTarget, expectedPendingBefore)) ||
        targetKey(pendingTarget) !== targetKeyFromState(this.#state.pending.beforeTarget) ||
        targetKey(pendingTarget) !== targetKeyFromState(this.#state.pending.afterTarget) ||
        (revision !== this.#state.pending.catalogRevisionBefore &&
          revision !== this.#state.pending.expectedCatalogRevisionAfter) ||
        (revision === this.#state.pending.catalogRevisionBefore && activeId !== expectedOldActive) ||
        sha256Canonical(this.#state.pending.previousApplication) !==
          sha256Canonical(expectedPreviousApplication) ||
        (this.#state.pending.operation === "reconcile-promoted" &&
          (this.#state.pending.previousApplication?.proposalId ?? null) !== reconcileRestoredId)
      ) {
        throw new EvolutionPersistenceValidationError(
          `Invalid application state: pending operation '${this.#state.pending.commandId}' does not match the catalog`,
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
    for (const command of this.#state.commands.values()) {
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
      if (
        audit.kind === "rejection" ||
        audit.kind === "archive" ||
        audit.kind === "unarchive" ||
        audit.kind === "delete" ||
        !("applicationCommandId" in audit) ||
        audit.applicationCommandId === undefined
      ) {
        continue;
      }
      const completed = completedByCommand.get(audit.applicationCommandId);
      const pending = this.#state.pending;
      const pendingOwnsAudit =
        pending !== null &&
        pending.commandId === audit.applicationCommandId &&
        this.#catalogOutcomeMatchesPending(pending, snapshot, revision);
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

  async reconcilePendingOnOpen(): Promise<void> {
    const pending = this.#state.pending;
    if (!pending) {
      return;
    }

    const proposal = this.#catalog.getProposal(pending.proposalId);
    if (!proposal) {
      this.#state.recoveryRequired = true;
      return;
    }
    if (proposal.candidate.kind === "role-prompt") {
      await this.#cleanPendingPromptTemps(proposal.candidate.path);
    }

    let liveTarget: TargetDigestState;
    try {
      liveTarget = await this.#targets.readTargetState(proposal.candidate);
    } catch {
      this.#state.recoveryRequired = true;
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
        this.#state.recoveryRequired = true;
        return;
      }
      await this.finalizePendingAs("aborted", catalogRevision, liveTarget.digest);
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
          await this.finalizePendingAs(
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
              this.#state.recoveryRequired = true;
              return;
            }
            await this.#catalog.promote(
              proposal.id,
              evidence,
              pending.humanDecision,
              this.#state.catalogWriter,
              pending.commandId,
            );
          } else if (proposal.status !== "promoted") {
            this.#state.recoveryRequired = true;
            return;
          }
        } else if (pending.operation === "rollback-applied") {
          if (proposal.status === "promoted") {
            await this.#catalog.rollback(
              proposal.id,
              pending.humanDecision,
              this.#state.catalogWriter,
              pending.commandId,
            );
          } else if (proposal.status !== "rolled-back") {
            this.#state.recoveryRequired = true;
            return;
          }
        } else if (pending.operation === "reconcile-promoted") {
          // Catalog already promoted; only application record needed
        } else {
          this.#state.recoveryRequired = true;
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
        this.#state.recoveryRequired = true;
        return;
      }
    }

    // anything else => fail closed
    this.#state.recoveryRequired = true;
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
    const syntheticPredecessorCommandId = pending.previousApplication?.commandId;
    if (
      pending.operation === "reconcile-promoted" &&
      syntheticPredecessorCommandId?.startsWith("legacy:") &&
      !this.#state.commands.has(syntheticPredecessorCommandId) &&
      ![...this.#state.applications.values()].some((application) =>
        applicationHistoryHasCommand(application, syntheticPredecessorCommandId),
      )
    ) {
      this.#state.completed = this.#state.completed.filter(
        (record) => record.commandId !== syntheticPredecessorCommandId,
      );
    }
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
    const proposal = this.#catalog.getProposal(pending.proposalId);
    if (proposal && !this.#state.commands.has(pending.commandId)) {
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
    this.#state.pending = null;
    this.#state.recoveryRequired = false;
    await this.persist(this.#state.revision + 1);
  }

  async persist(nextRevision: number): Promise<void> {
    if (nextRevision !== this.#state.revision + 1) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Application state revision must advance by exactly one",
      );
    }
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
    const validatedPayload = applicationPayloadSchema.safeParse(candidatePayload);
    if (!validatedPayload.success) {
      this.#state.recoveryRequired = true;
      this.#state.opened = false;
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
    const temporaryPath = `${this.#applicationFilePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
      await assertSafeRegularFileOrMissing(
        this.#io,
        this.#catalog.root,
        this.#applicationFilePath,
      );
      let diskContents: string | null;
      try {
        diskContents = await this.#io.readFile(this.#applicationFilePath, "utf8");
      } catch (error) {
        if (!isNotFound(error)) throw error;
        diskContents = null;
      }
      if (diskContents !== this.#state.persistedContents) {
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
      await this.#io.rename(temporaryPath, this.#applicationFilePath);
      renamed = true;
      await this.#io.syncDirectory(this.#evolutionDirectory);
      this.#state.revision = nextRevision;
      this.#state.persistedContents = serialized;
      this.publishCommittedState();
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      this.#state.recoveryRequired = true;
      this.#state.opened = false;
      if (renamed) {
        this.#state.recoveryRequired = true;
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
