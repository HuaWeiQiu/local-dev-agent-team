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
import type { LoadedConfig } from "../config/load.js";
import {
  GitManager,
  GitManagerError,
  type ExactTrackedFileCommitAuthorization,
} from "../git/manager.js";
import {
  StrategyBlueprintCatalog,
  StrategyBlueprintError,
} from "../strategies/catalog.js";
import type { EvolutionCatalogSnapshot } from "./catalog.js";
import {
  computeCandidateDigest,
  parseHumanDecision,
  type EvolutionProposal,
  type HumanDecision,
  type PromotionRecord,
  type RejectionRecord,
  type RollbackRecord,
} from "./domain.js";
import { DurableEvolutionCatalog } from "./persistence.js";
import {
  EVOLUTION_APPLICATION_FILENAME,
  EVOLUTION_PREVIEW_TTL_MS,
  EvolutionApplicationError,
  MAX_APPLICATION_HISTORY_DEPTH,
  applicationHistoryDepth,
  isolate,
  mapGitError,
  mapToApplicationError,
  requireCommandId,
  requireNonEmpty,
  sha256Bytes,
  sha256Canonical,
  sha256Text,
  targetFromCandidate,
  targetKey,
  targetKeyFromState,
  targetStatesEqual,
  type ApplicationCommandKind,
  type ApplicationCommandResult,
  type ApplicationCommandResultPayload,
  type ApplicationPreview,
  type ApplicationPreviewDescription,
  type ApplicationRecord,
  type ApplicationStateSnapshot,
  type ApplicationStatus,
  type CommandIdempotencyBinding,
  type CompletedApplicationRecord,
  type EvolutionApplicationFileIo,
  type EvolutionApplicationState,
  type PendingApplicationOperation,
  type TargetDigestState,
} from "./application-shared.js";
import { EvolutionApplicationJournal } from "./application-journal.js";
import { EvolutionApplicationPreviewStore } from "./application-preview.js";
import {
  EvolutionApplicationTargets,
  assertSafeRegularFileOrMissing,
  cleanOrphanTemps,
  createDirectoryChain,
} from "./application-target.js";

export {
  EVOLUTION_APPLICATION_DOCUMENT_VERSION,
  EVOLUTION_APPLICATION_FILENAME,
  EVOLUTION_PROMPT_MATERIAL_MAX_BYTES,
  EVOLUTION_PREVIEW_TTL_MS,
  EvolutionApplicationError,
  evolutionApplicationErrorCodes,
} from "./application-shared.js";
export type {
  ApplicationCommandKind,
  ApplicationCommandResult,
  ApplicationCommandResultPayload,
  ApplicationPreview,
  ApplicationPreviewDescription,
  ApplicationPreviewMaterial,
  ApplicationRecord,
  ApplicationStateSnapshot,
  ApplicationStatus,
  CommandIdempotencyBinding,
  CompletedApplicationRecord,
  EvolutionApplicationErrorCode,
  EvolutionApplicationFileIo,
  PendingApplicationOperation,
  TargetDigestState,
} from "./application-shared.js";

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
  #assertQuiescent: () => void | Promise<void>;
  #now: () => number;
  #queue: Promise<void> = Promise.resolve();
  readonly #state: EvolutionApplicationState;
  readonly #targets: EvolutionApplicationTargets;
  readonly #journal: EvolutionApplicationJournal;
  readonly #previewStore: EvolutionApplicationPreviewStore;

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
    this.#assertQuiescent = options.assertQuiescent;
    this.#now = options.now;
    this.#state = {
      revision: 0,
      applications: new Map(),
      pending: null,
      completed: [],
      commands: new Map(),
      recoveryRequired: false,
      opened: false,
      persistedContents: null,
      publishedState: Object.freeze({
        revision: 0,
        applications: Object.freeze([]),
        pending: null,
        completed: Object.freeze([]),
        recoveryRequired: false,
      }),
      catalogWriter: undefined,
    };
    this.#targets = new EvolutionApplicationTargets({
      io: options.io,
      root: options.catalog.root,
      objectsDirectory: options.objectsDirectory,
      strategies: options.strategies,
      git: options.git,
      loaded: options.loaded,
    });
    this.#journal = new EvolutionApplicationJournal({
      io: options.io,
      catalog: options.catalog,
      git: options.git,
      targets: this.#targets,
      state: this.#state,
      evolutionDirectory: options.evolutionDirectory,
      applicationFilePath: options.applicationFilePath,
      now: options.now,
    });
    this.#previewStore = new EvolutionApplicationPreviewStore({
      catalog: options.catalog,
      targets: this.#targets,
      state: this.#state,
      host: {
        assertOpen: () => this.#assertOpen(),
        assertWritable: () => this.#assertWritable(),
        requireProposal: (proposalId) => this.#requireProposal(proposalId),
        assertPolicyAllows: (proposal) => this.#assertPolicyAllows(proposal),
        assertPromotable: (proposal) => this.#assertPromotable(proposal),
        assertNoUnreconciledConflict: (proposal, op) =>
          this.#assertNoUnreconciledConflict(proposal, op),
      },
      now: options.now,
      previewTtlMs: options.previewTtlMs,
    });
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
    await coordinator.#journal.loadOrInit();
    coordinator.#state.catalogWriter = options.catalog.claimExclusiveWriter();
    try {
      await coordinator.#journal.reconcilePendingOnOpen();
      coordinator.#journal.publishCommittedState();
      coordinator.#state.opened = true;
      return coordinator;
    } catch (error) {
      options.catalog.releaseExclusiveWriter(coordinator.#state.catalogWriter);
      coordinator.#state.catalogWriter = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    return await this.#enqueue(async () => {
      this.#previewStore.clear();
      this.#state.opened = false;
      if (this.#state.catalogWriter) {
        this.#catalog.releaseExclusiveWriter(this.#state.catalogWriter);
        this.#state.catalogWriter = undefined;
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
    const application = this.#state.publishedState.applications.find(
      (record) => record.proposalId === proposalId,
    );
    return application === undefined ? undefined : isolate(application);
  }

  /** Snapshot application-state (not catalog). */
  getApplicationState(): ApplicationStateSnapshot {
    this.#assertOpen();
    return isolate(this.#state.publishedState);
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
        application: this.#state.publishedState,
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
    origin?: "automatic-controller-v1";
  }): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      const proposalInput = {
        id: input.id,
        createdAt: new Date(this.#now()).toISOString(),
        policy: input.policy,
        candidate: input.candidate,
        ...(input.origin ? { origin: input.origin } : {}),
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
        await this.#targets.ingestPromptMaterial(
          validated.candidate.contentDigest,
          input.promptContent,
        );
      } else if (input.promptContent !== undefined) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          "promptContent is only accepted for role-prompt candidates",
        );
      }
      return await this.#catalog.propose(proposalInput, this.#state.catalogWriter);
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
        this.#state.catalogWriter,
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
        this.#state.catalogWriter,
      );
    });
  }

  async evaluateAutomaticRun(
    proposalId: string,
    evidence: unknown,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number }> {
    return await this.#enqueue(async () => {
      this.#assertWritable();
      return await this.#catalog.evaluateAutomaticRun(
        proposalId,
        evidence,
        new Date(this.#now()).toISOString(),
        this.#state.catalogWriter,
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
          this.#state.catalogWriter,
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
        await this.#targets.readPromptObject(proposal.candidate.contentDigest);
        items.push(serverPreflightItem(
          "server-prompt-object-integrity-v1",
          "pass",
          "Content-addressed prompt object digest, size, permissions, and UTF-8 passed; candidate was not executed",
        ));
        try {
          const live = await this.#targets.readTargetState(proposal.candidate);
          if (!live.present || !live.digest) {
            throw new EvolutionApplicationError(
              "POLICY_DENIED",
              `Prompt target '${proposal.candidate.path}' must already exist`,
            );
          }
          await this.#targets.readLivePromptText(proposal.candidate.path, live.digest);
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
        this.#state.catalogWriter,
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
      }, this.#state.catalogWriter);
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
      return await this.#previewStore.createPromotionPreview(input);
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
      const existing = this.#state.commands.get(commandId);
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
      const existing = this.#state.commands.get(commandId);
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
      return await this.#previewStore.createRollbackPreview(input);
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
      return await this.#previewStore.describe(input);
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
      const existing = this.#state.commands.get(commandId);
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
      if (this.#state.applications.has(proposal.id)) {
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
      const beforeTarget = await this.#targets.readTargetState(proposal.candidate);
      let livePromptContent: Buffer | undefined;
      if (proposal.candidate.kind === "role-prompt") {
        if (!beforeTarget.present || !beforeTarget.digest) {
          throw new EvolutionApplicationError(
            "TARGET_DRIFTED",
            `Prompt target '${proposal.candidate.path}' must already exist for reconciliation`,
          );
        }
        livePromptContent = await this.#targets.readLivePromptBytes(
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
          await this.#targets.ingestPromptMaterial(beforeTarget.digest!, livePromptContent);
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
          this.#state.completed.push(legacyPredecessor.completion);
        }
        if (legacyPredecessor.application) {
          this.#state.applications.delete(legacyPredecessor.application.proposalId);
        }
        this.#state.applications.set(proposal.id, application);
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
        this.#state.completed.push(completed);
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
        this.#state.commands.set(commandId, binding);
        await this.#journal.persist(this.#state.revision + 1);
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
          await this.#targets.ingestPromptMaterial(
            proposal.candidate.contentDigest,
            input.promptContent,
          );
        } else {
          await this.#targets.readPromptObject(proposal.candidate.contentDigest);
        }
      } else if (input.promptContent !== undefined) {
        throw new EvolutionApplicationError(
          "POLICY_DENIED",
          "Legacy prompt material is only accepted for role-prompt reconciliation",
        );
      }
      const afterTarget = await this.#targets.plannedAfterState(proposal, beforeTarget);
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
        await this.#targets.ingestPromptMaterial(beforeTarget.digest!, livePromptContent);
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
        this.#state.completed.push(legacyPredecessor.completion);
      }
      this.#state.pending = pending;
      await this.#journal.persist(this.#state.revision + 1);

      try {
        await this.#targets.applyTarget(
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
        const live = await this.#targets.readTargetState(proposal.candidate);
        if (mapped.code !== "RECOVERY_REQUIRED" && live.digest === beforeTarget.digest) {
          await this.#journal.finalizePendingAs("aborted", revision, live.digest);
        } else {
          this.#state.recoveryRequired = true;
          await this.#journal.persist(this.#state.revision + 1).catch(() => undefined);
          throw mapToApplicationError(error, "RECOVERY_REQUIRED");
        }
        throw mapped;
      }

      const liveAfter = await this.#targets.readTargetState(proposal.candidate);
      if (!targetStatesEqual(liveAfter, afterTarget)) {
        this.#state.recoveryRequired = true;
        await this.#journal.persist(this.#state.revision + 1).catch(() => undefined);
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
        this.#state.applications.delete(legacyPredecessor.application.proposalId);
      }
      this.#state.applications.set(proposal.id, application);
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
      this.#state.completed.push(completed);
      this.#state.pending = null;
      const resultPayload: ApplicationCommandResultPayload = {
        proposal,
        committedCatalogRevision: revision,
        applicationStatus: "applied",
        beforeTargetDigest: applicationBeforeTarget.digest,
        afterTargetDigest: afterTarget.digest,
      };
      this.#state.commands.set(commandId, {
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
      await this.#journal.persist(this.#state.revision + 1);
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
    const existing = this.#state.commands.get(commandId);
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

    const preview = this.#previewStore.consume(input.token, {
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
      if (!this.#state.applications.has(proposal.id)) {
        throw new EvolutionApplicationError(
          "RECOVERY_REQUIRED",
          `Promoted proposal '${proposal.id}' has no application proof`,
        );
      }
    }

    const liveBefore = await this.#targets.readTargetState(proposal.candidate);
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
        ? await this.#targets.plannedAfterState(proposal, liveBefore)
        : await this.#targets.plannedRollbackState(
            proposal,
            this.#state.applications.get(proposal.id)!,
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
    this.#state.pending = pending;
    await this.#journal.persist(this.#state.revision + 1);
    this.#previewStore.drop(tokenDigest);

    // 1) Target apply
    try {
      if (input.operation === "promote-and-apply") {
        await this.#targets.applyTarget(
          proposal,
          preview.beforeTarget,
          preview.afterTarget,
          humanDecision,
          "apply",
          gitAuthorization,
        );
      } else {
        await this.#targets.applyTarget(
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
      const live = await this.#targets.readTargetState(proposal.candidate).catch(() => null);
      if (
        mapped.code !== "RECOVERY_REQUIRED" &&
        live &&
        live.digest === preview.beforeTarget.digest
      ) {
        await this.#journal.finalizePendingAs("aborted", revision, live.digest);
        throw mapped;
      }
      this.#state.recoveryRequired = true;
      await this.#journal.persist(this.#state.revision + 1).catch(() => undefined);
      throw mapToApplicationError(error, "RECOVERY_REQUIRED");
    }

    const liveAfterTarget = await this.#targets.readTargetState(proposal.candidate);
    if (!targetStatesEqual(liveAfterTarget, preview.afterTarget)) {
      this.#state.recoveryRequired = true;
      await this.#journal.persist(this.#state.revision + 1).catch(() => undefined);
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
          this.#state.catalogWriter,
          commandId,
        );
      } else {
        catalogResult = await this.#catalog.rollback(
          proposal.id,
          humanDecision,
          this.#state.catalogWriter,
          commandId,
        );
      }
    } catch (error) {
      // Target is new, catalog is old => leave pending for open-reconcile to finish catalog.
      this.#state.recoveryRequired = false;
      await this.#journal.persist(this.#state.revision + 1).catch(() => undefined);
      throw mapToApplicationError(error, "RECOVERY_REQUIRED");
    }

    if (sha256Canonical(catalogResult.record) !== pending.expectedAuditDigest) {
      this.#state.recoveryRequired = true;
      await this.#journal.persist(this.#state.revision + 1).catch(() => undefined);
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
        this.#state.applications.delete(preview.previousActiveProposalId);
      }
      this.#state.applications.set(proposal.id, {
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
      this.#state.applications.delete(proposal.id);
      const restoredId = (catalogResult.record as RollbackRecord).restoredActiveProposalId;
      const prior = preview.previousApplication?.previousApplication ?? null;
      if (restoredId && prior?.proposalId === restoredId) {
        this.#state.applications.set(restoredId, prior);
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
    this.#state.completed.push(completed);
    this.#state.pending = null;

    const resultPayload: ApplicationCommandResultPayload = {
      proposal: finalProposal,
      committedCatalogRevision: catalogResult.committedRevision,
      applicationStatus,
      beforeTargetDigest: preview.beforeTarget.digest,
      afterTargetDigest: preview.afterTarget.digest,
    };
    this.#state.commands.set(commandId, {
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
    await this.#journal.persist(this.#state.revision + 1);

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
    if (activeId && activeId !== proposal.id && !this.#state.applications.has(activeId)) {
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
    if (!this.#state.opened) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "EvolutionApplicationCoordinator is not open",
      );
    }
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (this.#state.recoveryRequired) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "Application state requires recovery before further mutations",
      );
    }
    if (this.#state.pending) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        "A pending application operation must be reconciled before further mutations",
      );
    }
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

    const existing = this.#state.applications.get(input.restoredProposalId);
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
    const expectedTarget = await this.#targets.plannedAfterState(predecessor, input.liveTarget);
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
