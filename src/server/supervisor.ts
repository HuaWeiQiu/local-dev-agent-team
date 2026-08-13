import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { LocalEvidenceStore } from "../evidence/local.js";
import type {
  EvidenceFilePreview,
  RunCleanupPreview,
  RunCleanupResult,
  RunEvidence,
} from "../evidence/types.js";
import { SqliteEventStore } from "../events/store.js";
import {
  materializeRoleBindings,
  roleBindingsFromRunState,
} from "../desktop/role-bindings.js";
import { resolveProfile } from "../profiles/resolve.js";
import { RunStateStore, summarizeRun } from "../state/store.js";
import type {
  ApprovalRequest,
  RunState,
  RunSummary,
} from "../state/types.js";
import { resolveStrategy } from "../strategies/resolve.js";
import { createRunId } from "../workflow/id.js";
import { LocalWorkflowRunner, type WorkflowResumeOptions } from "../workflow/runner.js";
import type {
  ApprovalResponseRequest,
  ResumeRunRequest,
  StartRunRequest,
} from "./contracts.js";
import { RunRecovery } from "./run-recovery.js";
import { RunRetention } from "./run-retention.js";

export type { RunUsageDetail, RunUsageEntry, UsageReport } from "./run-retention.js";
import type { UsageReport } from "./run-retention.js";

export interface StartRunResult {
  runId: string;
  deduplicated: boolean;
}

export interface EvolutionAutomationSession {
  start(request: StartRunRequest, idempotencyKey?: string): StartRunResult;
  cancel(runId: string): Promise<boolean>;
  beginTargetMutation(): () => void;
  release(): void;
}

export interface RunActionResult {
  runId: string;
  status: "resuming" | "ready-to-merge" | "blocked" | "unchanged";
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run '${runId}' was not found`);
    this.name = "RunNotFoundError";
  }
}

export class ProjectMutationConflictError extends Error {
  readonly code = "ACTIVE_RUN_CONFLICT" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProjectMutationConflictError";
  }
}

export interface SupervisorDependencies {
  runWorkflow?: (
    request: StartRunRequest,
    context: {
      runId: string;
      signal: AbortSignal;
      supervisorId: string;
      purpose?: "evolution-evaluation";
    },
  ) => Promise<RunState>;
  resumeWorkflow?: (
    state: RunState,
    options: WorkflowResumeOptions,
  ) => Promise<RunState>;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<RunState>;
  parentRunId?: string;
  idempotency?: { key: string; hash: string };
}

const activeStatuses = new Set([
  "created",
  "orchestrating",
  "architecting",
  "exploring",
  "planned",
  "implementing",
  "reviewing-testing",
  "reworking",
  "integrating",
  "final-checks",
  "publishing",
  "waiting-ci",
  "repairing",
]);

export class RunSupervisor {
  readonly id = randomUUID();
  private readonly active = new Map<string, ActiveRun>();
  private readonly actionQueues = new Map<string, Promise<void>>();
  private readonly stateStore: RunStateStore;
  private readonly evidenceStore: LocalEvidenceStore;
  private readonly retention: RunRetention;
  private readonly recovery: RunRecovery;
  private evolutionMutationActive = false;
  private evolutionOperationsSealed = false;
  private evolutionMutationFinished: Promise<void> = Promise.resolve();
  private finishEvolutionMutation: (() => void) | undefined;
  private automationOwner: symbol | undefined;

  constructor(
    private readonly loaded: LoadedConfig,
    readonly events: SqliteEventStore,
    private readonly dependencies: SupervisorDependencies = {},
  ) {
    this.stateStore = new RunStateStore(
      path.resolve(loaded.root, loaded.config.project.stateDirectory, "runs"),
      events,
    );
    this.evidenceStore = new LocalEvidenceStore(this.stateStore);
    this.retention = new RunRetention(this.loaded, this.stateStore, this.evidenceStore, events, {
      get: async (runId) => await this.get(runId),
      requireRun: async (runId) => await this.requireRun(runId),
      isActive: (runId) => this.active.has(runId),
      hasActiveChild: (runId) => this.hasActiveChild(runId),
      serializeActions: async (runIds, action) => await this.serializeActions(runIds, action),
    });
    this.recovery = new RunRecovery(this.loaded, this.stateStore, events, {
      recordApprovalResponse: async (state, approval, response) =>
        await this.recordApprovalResponse(state, approval, response),
    });
  }

  start(request: StartRunRequest, idempotencyKey?: string): StartRunResult {
    return this.startOwned(request, idempotencyKey);
  }

  beginAutomationSession(): EvolutionAutomationSession {
    if (this.evolutionOperationsSealed) {
      throw new ProjectMutationConflictError(
        "Automatic evolution cannot start while the control service is closing",
      );
    }
    if (this.automationOwner) {
      throw new ProjectMutationConflictError("Automatic evolution is already running");
    }
    if (this.evolutionMutationActive) {
      throw new ProjectMutationConflictError("A project target mutation is already in progress");
    }
    this.assertEvolutionQuiescent();
    const owner = Symbol("evolution-automation");
    this.automationOwner = owner;
    let released = false;
    return {
      start: (request, idempotencyKey) =>
        this.startOwned(request, idempotencyKey, owner, "evolution-evaluation"),
      cancel: (runId) => this.cancelOwned(runId, owner),
      beginTargetMutation: () => this.beginOwnedEvolutionMutation(owner),
      release: () => {
        if (released) return;
        if (this.evolutionMutationActive || this.active.size > 0 || this.actionQueues.size > 0) {
          throw new ProjectMutationConflictError(
            "Automatic evolution cannot release project ownership while work is active",
          );
        }
        released = true;
        if (this.automationOwner === owner) this.automationOwner = undefined;
      },
    };
  }

  private startOwned(
    request: StartRunRequest,
    idempotencyKey?: string,
    automationOwner?: symbol,
    purpose?: "evolution-evaluation",
  ): StartRunResult {
    resolveStrategy(this.loaded.config, request.strategy);

    let runConfig = this.loaded.config;
    let profileOverrides = { ...request.profileOverrides };
    const startBindings =
      request.roleBindings && Object.keys(request.roleBindings).length > 0
        ? request.roleBindings
        : roleBindingsFromRunState({ profileOverrides });
    if (Object.keys(startBindings).length > 0) {
      const material = materializeRoleBindings(this.loaded.config, startBindings);
      runConfig = material.config;
      // roleBindings win over legacy profileOverrides for the same role
      profileOverrides = {
        ...request.profileOverrides,
        ...material.profileOverrides,
      };
    }

    for (const [role, profile] of Object.entries(profileOverrides)) {
      resolveProfile(runConfig, role, profile);
    }

    const runId = createRunId(request.goal);
    const hash = idempotencyKey ? requestHash(request) : undefined;
    if (idempotencyKey) {
      const claim = this.events.claimCommand(
        idempotencyKey,
        hash!,
        { runId },
      );
      if (!claim.claimed) {
        const response = claim.response as { runId?: unknown };
        if (typeof response.runId !== "string") {
          throw new Error(`Invalid stored response for idempotency key '${idempotencyKey}'`);
        }
        return { runId: response.runId, deduplicated: true };
      }
    }

    let workflow: Promise<RunState>;
    try {
      this.assertRunStartAllowed(automationOwner);
      const controller = new AbortController();
      this.events.emit(runId, "run.queued", {
        goal: request.goal,
        strategy: request.strategy ?? this.loaded.config.strategies?.default ?? "legacy",
        ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
        ...(request.roleBindings ? { roleBindings: request.roleBindings } : {}),
      });
      const loadedForRun = runConfig === this.loaded.config
        ? this.loaded
        : { ...this.loaded, config: runConfig };
      workflow = this.dependencies.runWorkflow
        ? this.dependencies.runWorkflow(
            { ...request, profileOverrides },
            {
              runId,
              signal: controller.signal,
              supervisorId: this.id,
              ...(purpose ? { purpose } : {}),
            },
          )
        : new LocalWorkflowRunner(loadedForRun, { eventSink: this.events }).run({
            goal: request.goal,
            profileOverrides,
            ...(request.roleBindings ? { roleBindings: request.roleBindings } : {}),
            ...(request.strategy ? { strategyName: request.strategy } : {}),
            runId,
            signal: controller.signal,
            supervisorId: this.id,
            ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
            ...(purpose ? { purpose } : {}),
          });
      this.track(
        runId,
        controller,
        workflow,
        request.parentRunId,
        idempotencyKey && hash ? { key: idempotencyKey, hash } : undefined,
      );
    } catch (error) {
      if (idempotencyKey && hash) {
        this.events.releaseCommand(idempotencyKey, hash);
      }
      throw error;
    }
    return { runId, deduplicated: false };
  }

  /**
   * Acquire the project-wide target-mutation latch before an evolution apply,
   * rollback, or direct strategy mutation. The check and latch happen without
   * an await, so a run cannot start between quiescence validation and ownership.
   */
  beginEvolutionMutation(): () => void {
    return this.beginOwnedEvolutionMutation();
  }

  private beginOwnedEvolutionMutation(automationOwner?: symbol): () => void {
    if (this.evolutionOperationsSealed) {
      throw new ProjectMutationConflictError(
        "Evolution mutations are sealed while the control service is closing",
      );
    }
    if (this.evolutionMutationActive) {
      throw new ProjectMutationConflictError("Another project mutation is already in progress");
    }
    if (this.automationOwner && this.automationOwner !== automationOwner) {
      throw new ProjectMutationConflictError(
        "Automatic evolution owns the project until its bounded loop finishes",
      );
    }
    this.assertEvolutionQuiescent();
    this.evolutionMutationActive = true;
    this.evolutionMutationFinished = new Promise<void>((resolve) => {
      this.finishEvolutionMutation = resolve;
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.evolutionMutationActive = false;
      this.finishEvolutionMutation?.();
      this.finishEvolutionMutation = undefined;
    };
  }

  assertEvolutionQuiescent(): void {
    if (this.active.size > 0 || this.actionQueues.size > 0) {
      throw new ProjectMutationConflictError("Project has an active run or run action");
    }
  }

  async cancel(runId: string): Promise<boolean> {
    return await this.cancelOwned(runId);
  }

  /**
   * Pause an actively executing run: the workflow signal is aborted, the run
   * settles as `interrupted` (resumable from its latest checkpoint), and task
   * worktrees are kept so quality-passed tasks can be reused on resume.
   * Runs parked at a human gate or already terminal cannot be paused.
   */
  async pause(runId: string, request: { actor: string; reason: string }): Promise<boolean> {
    if (this.automationOwner) {
      throw new ProjectMutationConflictError(
        "Automatic evolution owns run control until its bounded loop finishes",
      );
    }
    const active = this.active.get(runId);
    if (active) {
      this.events.emit(runId, "run.pause-requested", {
        actor: request.actor,
        reason: request.reason,
      });
      active.controller.abort(new Error("Run paused by user"));
      return true;
    }
    const state = await this.get(runId);
    if (!state) {
      throw new Error(`Run '${runId}' was not found`);
    }
    throw new Error(
      `Run '${runId}' (${state.status}) cannot be paused: only actively executing runs can pause`,
    );
  }

  private async cancelOwned(runId: string, automationOwner?: symbol): Promise<boolean> {
    if (this.automationOwner && this.automationOwner !== automationOwner) {
      throw new ProjectMutationConflictError(
        "Automatic evolution owns run cancellation until its bounded loop finishes",
      );
    }
    const active = this.active.get(runId);
    if (active) {
      this.events.emit(runId, "run.cancel-requested", {});
      active.controller.abort(new Error("Run cancelled by user"));
      return true;
    }
    // Runs parked at a human gate or interrupted by a previous service are not
    // in the active map; cancel them with a direct terminal transition.
    const state = await this.get(runId);
    if (!state || !inactiveCancellableStatuses.has(state.status)) {
      return false;
    }
    return await this.queueRunAction([runId], async () => {
      const racing = this.active.get(runId);
      if (racing) {
        this.events.emit(runId, "run.cancel-requested", {});
        racing.controller.abort(new Error("Run cancelled by user"));
        return true;
      }
      const current = await this.get(runId);
      if (!current || !inactiveCancellableStatuses.has(current.status)) {
        return false;
      }
      this.events.emit(runId, "run.cancel-requested", {});
      current.error = "Run cancelled by user";
      await this.stateStore.transition(current, "cancelled", current.error);
      return true;
    });
  }

  async retry(
    runId: string,
    idempotencyKey?: string,
    options?: { fallbackRoleBindings?: StartRunRequest["roleBindings"] },
  ): Promise<StartRunResult> {
    return await this.serializeAction(runId, async () => {
      const source = await this.get(runId);
      if (!source) {
        throw new Error(`Run '${runId}' was not found`);
      }
      if (source.purpose === "evolution-proposer") {
        throw new Error(`Automatic evolution proposer run '${runId}' cannot be retried directly`);
      }
      if (!["blocked", "cancelled", "interrupted"].includes(source.status)) {
        throw new Error(`Run '${runId}' cannot be retried from status '${source.status}'`);
      }
      const copiedBindings = source.roleBindings
        ? Object.fromEntries(
            Object.entries(source.roleBindings).map(([role, binding]) => [
              role,
              {
                cli: binding.cli,
                ...(binding.model ? { model: binding.model } : {}),
                ...(binding.reasoning ? { reasoning: binding.reasoning } : {}),
              },
            ]),
          )
        : undefined;
      const roleBindings =
        copiedBindings && Object.keys(copiedBindings).length > 0
          ? copiedBindings
          : options?.fallbackRoleBindings;
      return this.start(
        {
          goal: source.goal,
          profileOverrides: source.profileOverrides,
          ...(roleBindings && Object.keys(roleBindings).length > 0 ? { roleBindings } : {}),
          ...(source.strategy.name !== "legacy" ? { strategy: source.strategy.name } : {}),
          parentRunId: source.id,
        },
        idempotencyKey,
      );
    });
  }

  async respondApproval(
    runId: string,
    response: ApprovalResponseRequest,
  ): Promise<RunActionResult> {
    return await this.serializeAction(runId, async () => {
      const state = await this.requireRun(runId);
      const approval = state.approvals?.find((item) => item.id === response.requestId);
      if (!approval) {
        throw new Error(`Approval request '${response.requestId}' was not found`);
      }
      if (state.approvals?.at(-1)?.id !== approval.id) {
        throw new Error(`Approval request '${approval.id}' is not the latest request`);
      }
      if (approval.status !== "pending") {
        if (
          approval.response?.decision === response.decision &&
          approval.response.actor === response.actor &&
          approval.response.reason === response.reason
        ) {
          return {
            runId,
            status: approval.status === "approved" ? "unchanged" : "blocked",
          };
        }
        throw new Error(`Approval request '${approval.id}' already has a response`);
      }
      if (this.active.has(runId)) {
        throw new Error(`Run '${runId}' is active and cannot accept an approval response`);
      }
      if (Date.now() > Date.parse(approval.expiresAt)) {
        await this.recordApprovalResponse(state, approval, {
          decision: "rejected",
          actor: "system:approval-expiry",
          reason: `Approval request expired at ${approval.expiresAt}`,
        });
        await this.stateStore.transition(state, "blocked", approval.response!.reason);
        throw new Error(`Approval request '${approval.id}' expired at ${approval.expiresAt}`);
      }

      await this.recordApprovalResponse(state, approval, response);
      if (response.decision === "rejected") {
        state.error = `Approval rejected by ${response.actor}: ${response.reason}`;
        await this.stateStore.transition(state, "blocked", state.error);
        return { runId, status: "blocked" };
      }
      if (approval.gate === "final") {
        delete state.error;
        await this.stateStore.transition(
          state,
          "ready-to-merge",
          `Final approval granted by ${response.actor}`,
        );
        return { runId, status: "ready-to-merge" };
      }

      await this.stateStore.transition(
        state,
        "planned",
        `Plan approved by ${response.actor}; continuation queued`,
      );
      try {
        this.startContinuation(state, {
          mode: "approval",
          actor: response.actor,
          reason: response.reason,
        });
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        await this.stateStore.transition(
          state,
          "interrupted",
          `Approved plan continuation could not start: ${state.error}`,
        );
        throw error;
      }
      return { runId, status: "resuming" };
    });
  }

  async resume(runId: string, request: ResumeRunRequest): Promise<RunActionResult> {
    return await this.serializeAction(runId, async () => {
      if (this.active.has(runId)) {
        throw new Error(`Run '${runId}' is already active`);
      }
      const state = await this.requireRun(runId);
      if (state.status !== "interrupted") {
        throw new Error(`Run '${runId}' cannot resume from status '${state.status}'`);
      }
      const checkpoint = state.checkpoints?.at(-1);
      if (!checkpoint) {
        throw new Error(`Run '${runId}' has no recoverable task-boundary checkpoint`);
      }
      if (
        checkpoint.stage === "plan-ready" &&
        (state.strategy.approvalGates ?? ["final"]).includes("plan")
      ) {
        const planApproval = state.approvals
          ?.filter((approval) => approval.gate === "plan")
          .at(-1);
        if (
          planApproval?.status !== "approved" ||
          planApproval.checkpointId !== checkpoint.id
        ) {
          throw new Error("Plan checkpoint requires approval before worker recovery");
        }
      }
      this.events.emit(runId, "run.resume-requested", {
        actor: request.actor,
        reason: request.reason,
        checkpointId: checkpoint.id,
      });
      this.startContinuation(state, {
        mode: "recovery",
        actor: request.actor,
        reason: request.reason,
      });
      return { runId, status: "resuming" };
    });
  }

  async wait(runId: string): Promise<RunState | undefined> {
    return await this.active.get(runId)?.promise;
  }

  async get(runId: string): Promise<RunState | undefined> {
    try {
      return await this.stateStore.load(runId);
    } catch {
      return undefined;
    }
  }

  async list(): Promise<RunSummary[]> {
    return (await this.stateStore.list()).map(summarizeRun);
  }

  async usageReport(): Promise<UsageReport> {
    return await this.retention.usageReport();
  }

  async evidence(runId: string): Promise<RunEvidence | undefined> {
    return await this.retention.evidence(runId);
  }

  async evidenceFile(runId: string, relativePath: string): Promise<EvidenceFilePreview> {
    return await this.retention.evidenceFile(runId, relativePath);
  }

  async previewCleanup(olderThanDays: number): Promise<RunCleanupPreview> {
    return await this.retention.previewCleanup(olderThanDays);
  }

  async cleanup(token: string): Promise<RunCleanupResult> {
    return await this.retention.cleanup(token);
  }

  /**
   * Delete one terminal run immediately (blocked/cancelled/completed/interrupted).
   * Active runs, parents of retained children, and non-terminal statuses are rejected.
   */
  async deleteRun(runId: string): Promise<RunCleanupResult> {
    return await this.retention.deleteRun(runId);
  }

  async reconcileInterruptedRuns(): Promise<number> {
    await this.discardQuarantineLeftovers();
    const states = await this.stateStore.list();
    let count = 0;
    for (const state of states) {
      if (await this.recovery.reconcileApprovalBoundary(state)) {
        count += 1;
        continue;
      }
      // The startup lease guarantees no other live supervisor, so an active
      // run owned by anybody else — including legacy runs persisted before
      // supervisorId existed (undefined) — belongs to a dead service.
      if (state.supervisorId !== this.id && activeStatuses.has(state.status)) {
        state.error = "The owning control service stopped before the run completed";
        await this.stateStore.transition(
          state,
          state.purpose === "evolution-proposer" ? "cancelled" : "interrupted",
          state.error,
        );
        count += 1;
      }
    }
    return count;
  }

  /**
   * Startup sweep for Git worktrees/branches left by runs that were deleted
   * before worktree cleanup existed. Runs with a persisted state are never
   * touched.
   */
  async reconcileUnknownWorktrees(): Promise<{
    removedDirectories: string[];
    removedBranches: number;
  }> {
    return await this.retention.sweepUnknownRunArtifacts();
  }

  /** Best-effort cleanup of `.deleting-*` directories left by interrupted cleanups. */
  private async discardQuarantineLeftovers(): Promise<void> {
    try {
      const discarded = await this.stateStore.discardQuarantineLeftovers();
      if (discarded > 0) {
        console.warn(
          `[agent-team] discarded ${discarded} quarantined run ${
            discarded === 1 ? "directory" : "directories"
          } left by an interrupted cleanup`,
        );
      }
    } catch (error) {
      // Never block startup on housekeeping.
      console.warn(
        `[agent-team] could not discard quarantine leftovers: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async close(): Promise<void> {
    this.evolutionOperationsSealed = true;
    await this.evolutionMutationFinished;
    await Promise.all([...new Set(this.actionQueues.values())]);
    this.retention.clearPreviews();
    for (const [runId, active] of this.active) {
      this.events.emit(runId, "run.cancel-requested", {
        reason: "control-service-shutdown",
      });
      active.controller.abort(new Error("Control service is shutting down"));
    }
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
  }

  private track(
    runId: string,
    controller: AbortController,
    workflow: Promise<RunState>,
    parentRunId?: string,
    idempotency?: { key: string; hash: string },
  ): Promise<RunState> {
    const promise = workflow
      .catch(async (error: unknown) => {
        this.events.emit(runId, "run.crashed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (idempotency) {
          // The workflow rejected before its state was ever persisted (e.g. a
          // disk failure): the run stays invisible, so release the command
          // claim and let an identical retry start a fresh run. A run that did
          // persist is visible and keeps its claim — the deduplicated response
          // is correct.
          try {
            await this.stateStore.load(runId);
          } catch {
            this.events.releaseCommand(idempotency.key, idempotency.hash);
          }
        }
        throw error;
      })
      .finally(() => {
        this.active.delete(runId);
      });
    this.active.set(runId, {
      controller,
      promise,
      ...(parentRunId ? { parentRunId } : {}),
      ...(idempotency ? { idempotency } : {}),
    });
    void promise.catch(() => undefined);
    return promise;
  }

  private startContinuation(
    state: RunState,
    options: Omit<WorkflowResumeOptions, "signal" | "supervisorId">,
  ): void {
    this.assertRunStartAllowed();
    const controller = new AbortController();
    const resumeOptions: WorkflowResumeOptions = {
      ...options,
      signal: controller.signal,
      supervisorId: this.id,
    };
    const loadedForResume = this.configForPersistedRun(state);
    const workflow = this.dependencies.resumeWorkflow
      ? this.dependencies.resumeWorkflow(state, resumeOptions)
      : new LocalWorkflowRunner(loadedForResume, { eventSink: this.events }).resume(
          state,
          resumeOptions,
        );
    this.track(state.id, controller, workflow);
  }

  /** Rebuild ephemeral desktop picker profiles before resume/approval continuation. */
  private configForPersistedRun(state: RunState): typeof this.loaded {
    const bindings = roleBindingsFromRunState(state);
    if (Object.keys(bindings).length === 0) {
      return this.loaded;
    }
    const material = materializeRoleBindings(this.loaded.config, bindings);
    return { ...this.loaded, config: material.config };
  }

  private assertRunStartAllowed(automationOwner?: symbol): void {
    if (this.evolutionOperationsSealed) {
      throw new ProjectMutationConflictError(
        "Control service is closing and cannot start another run",
      );
    }
    if (this.evolutionMutationActive) {
      throw new ProjectMutationConflictError(
        "Project target mutation is in progress; retry after it finishes",
      );
    }
    if (this.automationOwner && this.automationOwner !== automationOwner) {
      throw new ProjectMutationConflictError(
        "Automatic evolution owns the project until its bounded loop finishes",
      );
    }
  }

  private async recordApprovalResponse(
    state: RunState,
    approval: ApprovalRequest,
    response: Pick<ApprovalResponseRequest, "decision" | "actor" | "reason">,
  ): Promise<void> {
    approval.status = response.decision;
    approval.response = {
      ...response,
      respondedAt: new Date().toISOString(),
    };
    await this.stateStore.save(state);
    this.events.emit(state.id, "approval.responded", {
      requestId: approval.id,
      gate: approval.gate,
      ...approval.response,
    });
  }

  private async requireRun(runId: string): Promise<RunState> {
    const state = await this.get(runId);
    if (!state) throw new RunNotFoundError(runId);
    return state;
  }

  private hasActiveChild(runId: string): boolean {
    return [...this.active.values()].some((active) => active.parentRunId === runId);
  }

  private async serializeAction<T>(runId: string, action: () => Promise<T>): Promise<T> {
    return await this.serializeActions([runId], action);
  }

  private async serializeActions<T>(runIds: string[], action: () => Promise<T>): Promise<T> {
    if (this.evolutionOperationsSealed || this.evolutionMutationActive || this.automationOwner) {
      throw new ProjectMutationConflictError(
        "Project evolution is in progress; run actions are temporarily unavailable",
      );
    }
    return await this.queueRunAction(runIds, action);
  }

  private async queueRunAction<T>(runIds: string[], action: () => Promise<T>): Promise<T> {
    const ids = [...new Set(runIds)].sort();
    const previous = ids.map((runId) => this.actionQueues.get(runId) ?? Promise.resolve());
    const result = Promise.all(previous.map(async (queued) => await queued.catch(() => undefined)))
      .then(action);
    const queued = result.then(
      () => undefined,
      () => undefined,
    );
    for (const runId of ids) this.actionQueues.set(runId, queued);
    try {
      return await result;
    } finally {
      for (const runId of ids) {
        if (this.actionQueues.get(runId) === queued) this.actionQueues.delete(runId);
      }
    }
  }
}

const inactiveCancellableStatuses = new Set<RunState["status"]>([
  "awaiting-human",
  "interrupted",
]);

function requestHash(request: StartRunRequest): string {
  const normalized = {
    goal: request.goal,
    strategy: request.strategy ?? null,
    parentRunId: request.parentRunId ?? null,
    profileOverrides: Object.fromEntries(
      Object.entries(request.profileOverrides).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    roleBindings: request.roleBindings
      ? Object.fromEntries(
          Object.entries(request.roleBindings).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
