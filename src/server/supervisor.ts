import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { buildRunEvidence, LocalEvidenceStore } from "../evidence/local.js";
import type {
  EvidenceFilePreview,
  IntegrationDiffEvidence,
  RunCleanupCandidate,
  RunCleanupPreview,
  RunCleanupResult,
  RunEvidence,
} from "../evidence/types.js";
import { SqliteEventStore } from "../events/store.js";
import { GitManager } from "../git/manager.js";
import { materializeRoleBindings } from "../desktop/role-bindings.js";
import { resolveProfile } from "../profiles/resolve.js";
import { RunStateStore, summarizeRun } from "../state/store.js";
import type {
  ApprovalRequest,
  RunCheckpoint,
  RunState,
  RunSummary,
  RunUsage,
} from "../state/types.js";
import { legacyApprovalTimeoutSeconds } from "../strategies/defaults.js";
import { resolveStrategy } from "../strategies/resolve.js";
import { createRunId } from "../workflow/id.js";
import { LocalWorkflowRunner, type WorkflowResumeOptions } from "../workflow/runner.js";
import type {
  ApprovalResponseRequest,
  ResumeRunRequest,
  StartRunRequest,
} from "./contracts.js";

export interface StartRunResult {
  runId: string;
  deduplicated: boolean;
}

export interface EvolutionAutomationSession {
  start(request: StartRunRequest, idempotencyKey?: string): StartRunResult;
  cancel(runId: string): boolean;
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

export interface RunUsageDetail {
  agentInvocations: number;
  agentDurationMs: number;
  processOutputBytes: number;
  truncatedStreams: number;
  artifactBytes: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reportedCostUsd: number;
  costReported: boolean;
}

export interface RunUsageEntry {
  runId: string;
  goal: string;
  status: RunState["status"];
  strategy: string;
  createdAt: string;
  updatedAt: string;
  usage: RunUsageDetail;
}

export interface UsageReport {
  generatedAt: string;
  runCount: number;
  totals: RunUsageDetail;
  runs: RunUsageEntry[];
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
}

const activeStatuses = new Set([
  "created",
  "orchestrating",
  "architecting",
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
  private readonly cleanupPreviews = new Map<string, CleanupPreviewSnapshot>();
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
    if (request.roleBindings && Object.keys(request.roleBindings).length > 0) {
      const material = materializeRoleBindings(this.loaded.config, request.roleBindings);
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
            ...(request.strategy ? { strategyName: request.strategy } : {}),
            runId,
            signal: controller.signal,
            supervisorId: this.id,
            ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
            ...(purpose ? { purpose } : {}),
          });
      this.track(runId, controller, workflow, request.parentRunId);
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

  cancel(runId: string): boolean {
    return this.cancelOwned(runId);
  }

  private cancelOwned(runId: string, automationOwner?: symbol): boolean {
    if (this.automationOwner && this.automationOwner !== automationOwner) {
      throw new ProjectMutationConflictError(
        "Automatic evolution owns run cancellation until its bounded loop finishes",
      );
    }
    const active = this.active.get(runId);
    if (!active) {
      return false;
    }
    this.events.emit(runId, "run.cancel-requested", {});
    active.controller.abort(new Error("Run cancelled by user"));
    return true;
  }

  async retry(runId: string, idempotencyKey?: string): Promise<StartRunResult> {
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
      const roleBindings = source.roleBindings
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
    const states = await this.stateStore.list();
    const runs: RunUsageEntry[] = states
      .map((state) => ({
        runId: state.id,
        goal: state.goal,
        status: state.status,
        strategy: state.strategy.name,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        usage: usageDetail(state.usage),
      }))
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId),
      );
    const totals = runs.reduce(
      (acc, entry) => ({
        agentInvocations: acc.agentInvocations + entry.usage.agentInvocations,
        agentDurationMs: acc.agentDurationMs + entry.usage.agentDurationMs,
        processOutputBytes: acc.processOutputBytes + entry.usage.processOutputBytes,
        truncatedStreams: acc.truncatedStreams + entry.usage.truncatedStreams,
        artifactBytes: acc.artifactBytes + entry.usage.artifactBytes,
        inputTokens: acc.inputTokens + entry.usage.inputTokens,
        cachedInputTokens: acc.cachedInputTokens + entry.usage.cachedInputTokens,
        outputTokens: acc.outputTokens + entry.usage.outputTokens,
        reportedCostUsd: acc.reportedCostUsd + entry.usage.reportedCostUsd,
        costReported: acc.costReported || entry.usage.costReported,
      }),
      {
        agentInvocations: 0,
        agentDurationMs: 0,
        processOutputBytes: 0,
        truncatedStreams: 0,
        artifactBytes: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reportedCostUsd: 0,
        costReported: false,
      },
    );
    return {
      generatedAt: new Date().toISOString(),
      runCount: runs.length,
      totals,
      runs,
    };
  }

  async evidence(runId: string): Promise<RunEvidence | undefined> {
    const state = await this.get(runId);
    if (!state) return undefined;
    const [artifacts, diff] = await Promise.all([
      this.evidenceStore.listArtifacts(runId),
      this.integrationDiff(state),
    ]);
    return buildRunEvidence(state, artifacts, diff);
  }

  async evidenceFile(runId: string, relativePath: string): Promise<EvidenceFilePreview> {
    await this.requireRun(runId);
    return await this.evidenceStore.readArtifact(runId, relativePath);
  }

  async previewCleanup(olderThanDays: number): Promise<RunCleanupPreview> {
    if (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > 3_650) {
      throw new Error("Cleanup age must be an integer from 0 to 3650 days");
    }
    this.expireCleanupPreviews();
    // 0 = all eligible terminal runs (updatedAt < now + 1s effectively all past)
    const cutoff =
      olderThanDays === 0
        ? new Date(Date.now() + 1_000).toISOString()
        : new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const allStates = await this.stateStore.list();
    const protectedParents = new Set(allStates.map((state) => state.parentRunId).filter((id): id is string => Boolean(id)));
    const states = allStates.filter(
      (state) => cleanupStatuses.has(state.status) && state.updatedAt < cutoff && !protectedParents.has(state.id) && !this.hasActiveChild(state.id),
    );
    const candidates = await Promise.all(states.map(async (state): Promise<RunCleanupCandidate> => ({
      id: state.id,
      goal: state.goal,
      status: state.status as RunCleanupCandidate["status"],
      updatedAt: state.updatedAt,
      bytes: await this.evidenceStore.runBytes(state.id),
    })));
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + cleanupPreviewTtlMs).toISOString();
    this.cleanupPreviews.set(token, { expiresAt, candidates });
    return {
      token,
      expiresAt,
      olderThanDays,
      cutoff,
      candidates,
      totalBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    };
  }

  async cleanup(token: string): Promise<RunCleanupResult> {
    this.expireCleanupPreviews();
    const preview = this.cleanupPreviews.get(token);
    if (!preview) {
      throw new Error("Cleanup preview is missing or expired; create a new preview");
    }
    this.cleanupPreviews.delete(token);

    return await this.serializeActions(preview.candidates.map((candidate) => candidate.id), async () => {
      const currentStates = await this.stateStore.list();
      const currentById = new Map(currentStates.map((state) => [state.id, state]));
      const protectedParents = new Set(currentStates.map((state) => state.parentRunId).filter((id): id is string => Boolean(id)));
      for (const candidate of preview.candidates) {
        const current = currentById.get(candidate.id);
        if (
          !current ||
          current.status !== candidate.status ||
          current.updatedAt !== candidate.updatedAt ||
          !cleanupStatuses.has(current.status) ||
          this.active.has(candidate.id) ||
          this.hasActiveChild(candidate.id) ||
          protectedParents.has(candidate.id)
        ) {
          throw new Error(`Run '${candidate.id}' changed after preview; create a new preview`);
        }
      }

      const deletedRunIds: string[] = [];
      let reclaimedBytes = 0;
      for (const candidate of preview.candidates) {
        const quarantined = await this.stateStore.quarantine(candidate.id);
        try {
          this.events.deleteRun(candidate.id);
        } catch (error) {
          await this.stateStore.restoreQuarantined(quarantined);
          throw error;
        }
        await this.stateStore.removeQuarantined(quarantined);
        deletedRunIds.push(candidate.id);
        reclaimedBytes += candidate.bytes;
      }
      return { deletedRunIds, reclaimedBytes };
    });
  }

  /**
   * Delete one terminal run immediately (blocked/cancelled/completed/interrupted).
   * Active runs, parents of retained children, and non-terminal statuses are rejected.
   */
  async deleteRun(runId: string): Promise<RunCleanupResult> {
    return await this.serializeActions([runId], async () => {
      const state = await this.requireRun(runId);
      if (this.active.has(runId)) {
        throw new Error(`Run '${runId}' is still active; cancel it first`);
      }
      if (!cleanupStatuses.has(state.status)) {
        throw new Error(
          `Run '${runId}' status '${state.status}' cannot be deleted; only completed, cancelled, blocked, or interrupted runs`,
        );
      }
      if (this.hasActiveChild(runId)) {
        throw new Error(`Run '${runId}' still has an active child run`);
      }
      const allStates = await this.stateStore.list();
      const protectedParents = new Set(
        allStates.map((item) => item.parentRunId).filter((id): id is string => Boolean(id)),
      );
      if (protectedParents.has(runId)) {
        throw new Error(`Run '${runId}' is still referenced as a parent of another retained run`);
      }
      const bytes = await this.evidenceStore.runBytes(runId);
      const quarantined = await this.stateStore.quarantine(runId);
      try {
        this.events.deleteRun(runId);
      } catch (error) {
        await this.stateStore.restoreQuarantined(quarantined);
        throw error;
      }
      await this.stateStore.removeQuarantined(quarantined);
      return { deletedRunIds: [runId], reclaimedBytes: bytes };
    });
  }

  async reconcileInterruptedRuns(): Promise<number> {
    const states = await this.stateStore.list();
    let count = 0;
    for (const state of states) {
      if (await this.reconcileApprovalBoundary(state)) {
        count += 1;
        continue;
      }
      if (
        state.supervisorId !== undefined &&
        state.supervisorId !== this.id &&
        activeStatuses.has(state.status)
      ) {
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

  async close(): Promise<void> {
    this.evolutionOperationsSealed = true;
    await this.evolutionMutationFinished;
    await Promise.all([...new Set(this.actionQueues.values())]);
    this.cleanupPreviews.clear();
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
  ): Promise<RunState> {
    const promise = workflow
      .catch((error: unknown) => {
        this.events.emit(runId, "run.crashed", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.active.delete(runId);
      });
    this.active.set(runId, { controller, promise, ...(parentRunId ? { parentRunId } : {}) });
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
    const workflow = this.dependencies.resumeWorkflow
      ? this.dependencies.resumeWorkflow(state, resumeOptions)
      : new LocalWorkflowRunner(this.loaded, { eventSink: this.events }).resume(
          state,
          resumeOptions,
        );
    this.track(state.id, controller, workflow);
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

  private async integrationDiff(state: RunState): Promise<IntegrationDiffEvidence> {
    const targetCommit = state.checkpoints?.at(-1)?.integrationCommit;
    if (!targetCommit) {
      return {
        available: false,
        baseCommit: state.baseCommit,
        changedFiles: [],
        truncated: false,
        detail: "尚未生成持久化集成检查点",
      };
    }
    const git = new GitManager(
      this.loaded.root,
      path.resolve(this.loaded.root, this.loaded.config.project.stateDirectory, "worktrees"),
    );
    try {
      const diff = await git.diffBetween(state.baseCommit, targetCommit);
      return {
        available: true,
        baseCommit: state.baseCommit,
        targetCommit,
        changedFiles: diff.changedFiles,
        content: diff.content,
        truncated: diff.truncated,
      };
    } catch {
      return {
        available: false,
        baseCommit: state.baseCommit,
        targetCommit,
        changedFiles: [],
        truncated: false,
        detail: "记录的 Git 检查点当前不可读取",
      };
    }
  }

  private expireCleanupPreviews(): void {
    const now = Date.now();
    for (const [token, preview] of this.cleanupPreviews) {
      if (Date.parse(preview.expiresAt) <= now) this.cleanupPreviews.delete(token);
    }
  }

  private hasActiveChild(runId: string): boolean {
    return [...this.active.values()].some((active) => active.parentRunId === runId);
  }

  private async reconcileApprovalBoundary(state: RunState): Promise<boolean> {
    const checkpoint = await this.rebuildMissingCheckpoint(state);
    const requiredGate = checkpoint ? requiredApprovalGate(state, checkpoint.stage) : undefined;
    const approval = requiredGate
      ? state.approvals?.find(
          (item) => item.gate === requiredGate && item.checkpointId === checkpoint?.id,
        )
      : state.approvals?.at(-1);
    if (checkpoint && requiredGate && !approval) {
      return await this.restoreMissingApprovalRequest(state, checkpoint, requiredGate);
    }
    if (!approval) return false;
    if (approval.status === "pending") {
      return await this.reconcilePendingApproval(state, approval);
    }
    if (approval.status === "rejected") {
      return await this.reconcileRejectedApproval(state, approval);
    }
    if (approval.status === "approved") {
      return await this.reconcileApprovedApproval(state, approval);
    }
    return false;
  }

  /** Rebuilds the final-gate checkpoint for runs persisted before checkpoints existed. */
  private async rebuildMissingCheckpoint(state: RunState): Promise<RunCheckpoint | undefined> {
    const existing = state.checkpoints?.at(-1);
    if (existing) return existing;
    if (
      state.status !== "awaiting-human" ||
      !state.finalQuality?.passed ||
      state.finalDecision?.decision !== "ready"
    ) {
      return undefined;
    }
    const git = this.integrationGitManager();
    const [integrationCommit, clean] = await Promise.all([
      git.currentCommit(state.integrationWorktree).catch(() => undefined),
      git.isClean(state.integrationWorktree).catch(() => false),
    ]);
    if (!integrationCommit || !clean) return undefined;
    const checkpoint: RunCheckpoint = {
      id: randomUUID(),
      version: 1,
      stage: "local-gates-passed",
      integrationCommit,
      completedTaskIds: state.tasks
        .filter((task) => task.status === "merged")
        .map((task) => task.task.id)
        .sort(),
      createdAt: new Date().toISOString(),
    };
    state.checkpoints = [checkpoint];
    this.events.emit(state.id, "workflow.checkpoint-migrated", checkpoint);
    return checkpoint;
  }

  private async restoreMissingApprovalRequest(
    state: RunState,
    checkpoint: RunCheckpoint,
    requiredGate: ApprovalRequest["gate"],
  ): Promise<boolean> {
    const git = this.integrationGitManager();
    const [currentCommit, clean] = await Promise.all([
      git.currentCommit(state.integrationWorktree).catch(() => undefined),
      git.isClean(state.integrationWorktree).catch(() => false),
    ]);
    if (currentCommit !== checkpoint.integrationCommit || !clean) {
      return false;
    }
    const requestedAt = new Date();
    const approval: ApprovalRequest = {
      id: randomUUID(),
      gate: requiredGate,
      status: "pending",
      summary: requiredGate === "plan"
        ? `Approve ${state.tasks.length} planned task(s) before worker execution`
        : "All local gates passed; approve the integration result before publication",
      checkpointId: checkpoint.id,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(
        requestedAt.getTime() + (state.strategy.approvalTimeoutSeconds ?? legacyApprovalTimeoutSeconds) * 1_000,
      ).toISOString(),
    };
    state.approvals = [...(state.approvals ?? []), approval];
    await this.stateStore.transition(state, "awaiting-human", approval.summary);
    this.events.emit(state.id, "approval.requested", approval);
    return true;
  }

  private integrationGitManager(): GitManager {
    return new GitManager(
      this.loaded.root,
      path.resolve(this.loaded.root, this.loaded.config.project.stateDirectory, "worktrees"),
    );
  }

  private async reconcilePendingApproval(
    state: RunState,
    approval: ApprovalRequest,
  ): Promise<boolean> {
    if (Date.now() > Date.parse(approval.expiresAt)) {
      await this.recordApprovalResponse(state, approval, {
        decision: "rejected",
        actor: "system:approval-expiry",
        reason: `Approval request expired at ${approval.expiresAt}`,
      });
      state.error = approval.response!.reason;
      await this.stateStore.transition(state, "blocked", state.error);
      return true;
    }
    if (state.status !== "awaiting-human") {
      await this.stateStore.transition(state, "awaiting-human", approval.summary);
      return true;
    }
    return false;
  }

  private async reconcileRejectedApproval(
    state: RunState,
    approval: ApprovalRequest,
  ): Promise<boolean> {
    if (state.status === "blocked") return false;
    state.error = `Approval rejected by ${approval.response?.actor ?? "unknown"}: ${approval.response?.reason ?? "no reason"}`;
    await this.stateStore.transition(state, "blocked", state.error);
    return true;
  }

  private async reconcileApprovedApproval(
    state: RunState,
    approval: ApprovalRequest,
  ): Promise<boolean> {
    if (approval.gate === "final" && state.status !== "ready-to-merge") {
      delete state.error;
      await this.stateStore.transition(state, "ready-to-merge", "Recovered final approval response");
      return true;
    }
    if (approval.gate === "plan" && state.status === "awaiting-human") {
      state.error = "Plan approval was recorded before its continuation started";
      await this.stateStore.transition(state, "interrupted", state.error);
      return true;
    }
    return false;
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

interface CleanupPreviewSnapshot {
  expiresAt: string;
  candidates: RunCleanupCandidate[];
}

const cleanupPreviewTtlMs = 5 * 60_000;
const cleanupStatuses = new Set<RunState["status"]>([
  "completed",
  "cancelled",
  "blocked",
  "interrupted",
]);

function requiredApprovalGate(
  state: RunState,
  stage: import("../state/types.js").CheckpointStage,
): ApprovalRequest["gate"] | undefined {
  if (
    stage === "plan-ready" &&
    (state.strategy.approvalGates ?? ["final"]).includes("plan")
  ) {
    return "plan";
  }
  return stage === "local-gates-passed" ? "final" : undefined;
}

function usageDetail(usage: RunUsage | undefined): RunUsageDetail {
  return {
    agentInvocations: usage?.agentInvocations ?? 0,
    agentDurationMs: usage?.agentDurationMs ?? 0,
    processOutputBytes: usage?.processOutputBytes ?? 0,
    truncatedStreams: usage?.truncatedStreams ?? 0,
    artifactBytes: usage?.artifactBytes ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reportedCostUsd: usage?.reportedCostUsd ?? 0,
    costReported: usage?.reportedCostUsd !== undefined,
  };
}

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
