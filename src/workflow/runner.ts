import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { RoleAgentService } from "../agents/service.js";
import { ProfiledAgentService } from "../agents/service.js";
import {
  advisorVerdictSchema,
  exploreSummarySchema,
  finalDecisionSchema,
  goalIntakeSchema,
  reviewVerdictSchema,
  taskPlanSchema,
  testVerdictSchema,
  type AdvisorVerdict,
  type ExploreSummary,
  type ReviewVerdict,
  type TestVerdict,
} from "../domain/contracts.js";
import {
  advisorVerdictJsonSchema,
  exploreSummaryJsonSchema,
  finalDecisionJsonSchema,
  goalIntakeJsonSchema,
  reviewVerdictJsonSchema,
  taskPlanJsonSchema,
  testVerdictJsonSchema,
} from "../domain/json-schemas.js";
import { mkdir, writeFile } from "node:fs/promises";
import {
  assessPlanCompleteness,
  canUseHandoverFallback,
  expandPlanningGoal,
  fallbackHandoverTaskPlan,
  fallbackNamedTaskPlan,
  formatPlanCompletenessError,
  selectTaskWave,
  taskUsesProjectQualityGates,
  validateTaskPlan,
} from "../domain/plan.js";
import { GitManager } from "../git/manager.js";
import { ensureWorktreeNodeModules, formatQualityFailure } from "../quality/install.js";
import {
  deduplicateCommands,
  runQualityCommands,
  type QualityReport,
} from "../quality/run.js";
import { RunStateStore } from "../state/store.js";
import type {
  ApprovalRequest,
  CheckpointStage,
  RecoveryRecord,
  RunCheckpoint,
  RunRoleBinding,
  RunState,
  TaskRunState,
} from "../state/types.js";
import { RunArtifactCleaner } from "./cleanup.js";
import { RunExperienceRecorder } from "./experience-recorder.js";
import { branchSegment, createRunId } from "./id.js";
import {
  latestCheckpoint,
  truncateExploreSummary,
  latestApproval,
  requiresPlanApproval,
  pathExists,
  resetIncompleteTask,
  isBudgetExceededError,
  recoveryArtifactKey,
  taskArtifactKey,
  findTaskState,
  terminalStatusAfterFailure,
} from "./state-helpers.js";
import {
  isPlaceholderVerdict,
  shouldAcceptDocsDespiteEscalate,
  isHardSpecialistEscalation,
  shouldTrustQualityOverReview,
  passesTaskGates,
  buildReworkFeedback,
  compactQuality,
} from "./verdict-policy.js";

import {
  computeFailureSignature,
  isRepeatedFailure,
  type FailureSignature,
  type FailureSignatureInput,
} from "./failure-signature.js";
import { JevClient } from "../jev/client.js";
import {
  resolveConsultation,
  type ConsultationResolution,
  type ForkAdvisor,
  type JevDecision,
  type JevDecisionInput,
} from "../jev/policy.js";
import { resolveStrategy } from "../strategies/resolve.js";
import { legacyExecutionTimeoutSeconds } from "../strategies/defaults.js";
import type { RunEventSink } from "../events/types.js";
import { traceIdForRun } from "../events/store.js";
import {
  createExecutionDeadline,
  RunBudgetExceededError,
  RunBudgetTracker,
} from "../observability/budget.js";
import {
  materializeRoleBindings,
  roleBindingsFromRunState,
} from "../desktop/role-bindings.js";
import type { AdvisorTrigger, AgentTeamConfig } from "../config/schema.js";

export {
  isHardSpecialistEscalation,
  isPlaceholderVerdict,
  shouldAcceptDocsDespiteEscalate,
  shouldTrustQualityOverReview,
} from "./verdict-policy.js";
export { terminalStatusAfterFailure } from "./state-helpers.js";

type WorkflowRoleBindings = Record<
  string,
  { cli: RunRoleBinding["cli"]; model?: string | undefined; reasoning?: string | undefined }
>;

export interface WorkflowRunOptions {
  goal: string;
  profileOverrides?: Record<string, string>;
  roleBindings?: WorkflowRoleBindings;
  strategyName?: string;
  runId?: string;
  signal?: AbortSignal;
  supervisorId?: string;
  parentRunId?: string;
  purpose?: "evolution-evaluation";
}

export interface WorkflowDependencies {
  createAgentService?: (
    store: RunStateStore,
    profileOverrides: Record<string, string>,
    signal?: AbortSignal,
  ) => RoleAgentService;
  eventSink?: RunEventSink;
  /** Overrides the client built from `config.jev`; mainly for tests. */
  forkAdvisor?: ForkAdvisor;
}

export interface WorkflowResumeOptions {
  mode: "approval" | "recovery";
  actor: string;
  reason: string;
  signal?: AbortSignal;
  supervisorId?: string;
}

export class LocalWorkflowRunner {
  private readonly runsDirectory: string;
  private readonly worktreesDirectory: string;
  private readonly forkAdvisor: ForkAdvisor | undefined;
  private readonly experience: RunExperienceRecorder;
  private readonly cleaner: RunArtifactCleaner;

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly dependencies: WorkflowDependencies = {},
  ) {
    const stateRoot = path.resolve(loaded.root, loaded.config.project.stateDirectory);
    this.runsDirectory = path.join(stateRoot, "runs");
    this.worktreesDirectory = path.join(stateRoot, "worktrees");
    this.experience = new RunExperienceRecorder(loaded);
    this.cleaner = new RunArtifactCleaner(this.worktreesDirectory);
    const jev = loaded.config.jev;
    this.forkAdvisor =
      dependencies.forkAdvisor ?? (jev?.enabled ? new JevClient(jev) : undefined);
  }

  async run(options: WorkflowRunOptions): Promise<RunState> {
    const profileOverrides = options.profileOverrides ?? {};
    const strategy = resolveStrategy(this.loaded.config, options.strategyName);
    const effectiveProfileOverrides = {
      ...strategy.roleProfiles,
      ...profileOverrides,
    };
    const runId = options.runId ?? createRunId(options.goal);
    const store = new RunStateStore(this.runsDirectory, this.dependencies.eventSink);
    const git = new GitManager(this.loaded.root, this.worktreesDirectory);
    const integrationBranch = `agent-team/${branchSegment(runId)}/integration`;
    const integrationWorktree = path.join(this.worktreesDirectory, runId, "integration");
    const now = new Date().toISOString();
    const persistedBindings = options.roleBindings
      ? Object.fromEntries(
          Object.entries(options.roleBindings).flatMap(([role, binding]) => {
            const profileName = profileOverrides[role];
            if (!profileName) return [];
            const entry: RunRoleBinding = {
              cli: binding.cli,
              ...(binding.model ? { model: binding.model } : {}),
              ...(binding.reasoning ? { reasoning: binding.reasoning } : {}),
              profileName,
            };
            return [[role, entry]];
          }),
        )
      : undefined;
    let baseCommit: string;
    try {
      await git.assertReady();
      baseCommit = await git.resolveCommit(this.loaded.config.project.defaultBranch);
    } catch (error) {
      // Failures before the first save (e.g. dirty primary worktree) must still
      // persist a terminal state, otherwise the run vanishes from the run list.
      const message = error instanceof Error ? error.message : String(error);
      const terminal = terminalStatusAfterFailure(error, options.signal);
      const failed: RunState = {
        id: runId,
        traceId: traceIdForRun(runId),
        goal: options.goal,
        root: this.loaded.root,
        configPath: this.loaded.path,
        baseBranch: this.loaded.config.project.defaultBranch,
        baseCommit: "",
        integrationBranch,
        integrationWorktree,
        status: terminal,
        createdAt: now,
        updatedAt: now,
        profileOverrides,
        ...(persistedBindings && Object.keys(persistedBindings).length > 0
          ? { roleBindings: persistedBindings }
          : {}),
        strategy,
        ...(options.supervisorId ? { supervisorId: options.supervisorId } : {}),
        ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        ...(options.purpose ? { purpose: options.purpose } : {}),
        tasks: [],
        error: message,
        history: [
          { at: now, status: "created", message: "Run created" },
          { at: now, status: terminal, message },
        ],
      };
      await store.save(failed);
      return failed;
    }
    const state: RunState = {
      id: runId,
      traceId: traceIdForRun(runId),
      goal: options.goal,
      root: this.loaded.root,
      configPath: this.loaded.path,
      baseBranch: this.loaded.config.project.defaultBranch,
      baseCommit,
      integrationBranch,
      integrationWorktree,
      status: "created",
      createdAt: now,
      updatedAt: now,
      profileOverrides,
      ...(persistedBindings && Object.keys(persistedBindings).length > 0
        ? { roleBindings: persistedBindings }
        : {}),
      strategy,
      ...(options.supervisorId ? { supervisorId: options.supervisorId } : {}),
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
      tasks: [],
      history: [{ at: now, status: "created", message: "Run created" }],
    };
    await store.save(state);
    const segmentStartedAt = Date.now();
    const deadline = createExecutionDeadline(strategy.executionTimeoutSeconds, options.signal);
    const workflowSignal = deadline.signal;
    const budget = new RunBudgetTracker(state, store);
    const agent = this.createRoleAgentService(
      store,
      effectiveProfileOverrides,
      workflowSignal,
      budget,
      options.roleBindings,
    );

    try {
      workflowSignal.throwIfAborted();
      await git.createWorktree(integrationBranch, baseCommit, integrationWorktree);
      await this.prepareWorktreeDependencies(integrationWorktree, workflowSignal, state.strategy.maxProcessOutputBytes);
      const verifiedExperiences = await this.experience.loadPlanning(options.goal, store, runId);
      const planningGoal = expandPlanningGoal(options.goal, this.loaded.root);
      const allowImpliedHandover = canUseHandoverFallback(options.goal, this.loaded.root);
      const deterministicPlan = fallbackNamedTaskPlan(planningGoal);
      if (deterministicPlan) {
        validateTaskPlan(deterministicPlan);
        const completeness = assessPlanCompleteness(deterministicPlan, planningGoal, { allowImpliedHandover });
        if (completeness.status !== "rejected") {
          await store.transition(
            state,
            "architecting",
            "目标已写明任务与路径，控制面直接生成 DAG（不调用架构模型）",
          );
          state.plan = deterministicPlan;
          state.tasks = deterministicPlan.tasks.map((task) => ({
            task,
            status: "pending",
            attempts: 0,
          }));
          await store.transition(state, "planned", `Controller produced ${state.tasks.length} task(s) from the goal`);
          const checkpoint = await this.recordCheckpoint(state, store, git, "plan-ready");
          // The plan gate applies to controller-produced DAGs exactly as it
          // does to architect-produced plans: otherwise a named-path goal
          // would silently bypass the gate and the run would later become
          // unrecoverable (recovery requires the approval this path skipped).
          const planGate = requiresPlanApproval(state);
          if (planGate && state.purpose !== "evolution-evaluation") {
            await this.requestApproval(
              state,
              store,
              checkpoint,
              "plan",
              `Approve ${state.tasks.length} planned task(s) before worker execution`,
            );
            return state;
          }
          return await this.continueFromCheckpoint(
            state,
            checkpoint,
            store,
            git,
            agent,
            budget,
            workflowSignal,
          );
        }
      }
      await store.transition(state, "orchestrating", "Supervising agent is analyzing the goal");
      const intake = await agent.runStructured({
        role: "orchestrator",
        runId,
        artifactKey: "intake",
        context: {
          goal: planningGoal,
          project: this.loaded.config.project,
          baseCommit,
          ...(verifiedExperiences ? { verifiedExperiences } : {}),
        },
        schema: goalIntakeSchema,
        jsonSchema: goalIntakeJsonSchema,
      });
      state.intake = intake.value;
      await store.save(state);

      const exploreSummary = await this.maybeExplore(
        state,
        store,
        agent,
        planningGoal,
        baseCommit,
        verifiedExperiences,
      );

      await store.transition(state, "architecting", "架构正在拆分任务 DAG（plan）");
      const workerRole = this.loaded.config.roles.worker;
      if (!workerRole) {
        throw new Error("Required worker role is missing");
      }
      let architecture = await agent.runStructured({
        role: "architect",
        runId,
        artifactKey: "architecture",
        context: {
          goal: planningGoal,
          intake: intake.value,
          project: this.loaded.config.project,
          baseCommit,
          roleProfiles: workerRole.allowedProfiles,
          ...(verifiedExperiences ? { verifiedExperiences } : {}),
          ...(exploreSummary ? { exploreSummary } : {}),
        },
        schema: taskPlanSchema,
        jsonSchema: taskPlanJsonSchema,
      });
      validateTaskPlan(architecture.value);
      let completeness = assessPlanCompleteness(architecture.value, planningGoal, { allowImpliedHandover });
      if (completeness.status === "rejected") {
        architecture = await agent.runStructured({
          role: "architect",
          runId,
          artifactKey: "architecture-retry",
          context: {
            goal: planningGoal,
            intake: {
              ...intake.value,
              instructionsForArchitect: [
                intake.value.instructionsForArchitect,
                `Previous plan was rejected: ${completeness.issues.join("；")}.`,
                "Do not emit reconnaissance-only tasks. Produce one implementable task for each named T1–Tn / P0.x deliverable now.",
              ].join(" "),
            },
            project: this.loaded.config.project,
            baseCommit,
            roleProfiles: workerRole.allowedProfiles,
            previousRejectedPlan: architecture.value,
            completenessIssues: completeness.issues,
            ...(verifiedExperiences ? { verifiedExperiences } : {}),
            ...(exploreSummary ? { exploreSummary } : {}),
          },
          schema: taskPlanSchema,
          jsonSchema: taskPlanJsonSchema,
        });
        validateTaskPlan(architecture.value);
        completeness = assessPlanCompleteness(architecture.value, planningGoal, { allowImpliedHandover });
      }
      if (completeness.status === "rejected") {
        const fallback =
          fallbackNamedTaskPlan(planningGoal)
          ?? (allowImpliedHandover ? fallbackHandoverTaskPlan() : undefined);
        const fallbackReport = fallback
          ? assessPlanCompleteness(fallback, planningGoal, { allowImpliedHandover })
          : undefined;
        if (fallback && fallbackReport && fallbackReport.status !== "rejected") {
          architecture = {
            ...architecture,
            value: fallback,
            text: JSON.stringify(fallback),
          };
          completeness = fallbackReport;
        } else {
          throw new Error(formatPlanCompletenessError(completeness));
        }
      }
      state.plan = architecture.value;
      state.tasks = architecture.value.tasks.map((task) => ({
        task,
        status: "pending",
        attempts: 0,
      }));
      await store.transition(state, "planned", `Architect produced ${state.tasks.length} task(s)`);
      const checkpoint = await this.recordCheckpoint(state, store, git, "plan-ready");
      const planGate = requiresPlanApproval(state);
      if (planGate && state.purpose !== "evolution-evaluation") {
        await this.requestApproval(
          state,
          store,
          checkpoint,
          "plan",
          `Approve ${state.tasks.length} planned task(s) before worker execution`,
        );
        return state;
      }
      return await this.continueFromCheckpoint(
        state,
        checkpoint,
        store,
        git,
        agent,
        budget,
        workflowSignal,
      );
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      // A user pause settles as interrupted (resumable) instead of cancelled
      // and keeps task worktrees, so quality-passed tasks can be reused by
      // resume. The pause is recognized by its deterministic abort message
      // rather than a state flag, which could be overwritten by a racing save.
      const paused = /paused by user/i.test(state.error);
      await store.transition(
        state,
        terminalStatusAfterFailure(error, workflowSignal),
        state.error,
      );
      if (!paused) {
        await this.experience.extractFromRun(state, store);
        await this.cleaner.cleanup(state, store, git);
      }
      return state;
    } finally {
      deadline.dispose();
      await this.recordExecutionSegment(state, store, segmentStartedAt);
    }
  }

  async resume(state: RunState, options: WorkflowResumeOptions): Promise<RunState> {
    const store = new RunStateStore(this.runsDirectory, this.dependencies.eventSink);
    const git = new GitManager(this.loaded.root, this.worktreesDirectory);
    // The execution timeout is prorated across segments: accumulated wall
    // clock time from earlier runs/resumes is deducted, and an exhausted
    // budget blocks the resume instead of restarting the full window.
    const executionTimeoutSeconds =
      state.strategy.executionTimeoutSeconds ?? legacyExecutionTimeoutSeconds;
    const elapsedMs = state.executionElapsedMs ?? 0;
    const remainingSeconds = Math.max(0, executionTimeoutSeconds - elapsedMs / 1_000);
    if (remainingSeconds <= 0) {
      state.error = `Execution time budget of ${executionTimeoutSeconds}s exhausted across resumed segments`;
      await store.transition(state, "blocked", state.error);
      return state;
    }
    const segmentStartedAt = Date.now();
    const deadline = createExecutionDeadline(remainingSeconds, options.signal);
    const workflowSignal = deadline.signal;
    const effectiveProfileOverrides = {
      ...state.strategy.roleProfiles,
      ...state.profileOverrides,
    };
    const budget = new RunBudgetTracker(state, store);
    const agent = this.createRoleAgentService(
      store,
      effectiveProfileOverrides,
      workflowSignal,
      budget,
      state,
    );
    let checkpoint: RunCheckpoint;
    try {
      // Pre-execution validation only. Failures here (dirty worktree, stale
      // checkpoint, mismatched approval) must keep the current status
      // (interrupted/awaiting-human) so the run stays resumable once the
      // operator fixes the underlying problem.
      workflowSignal.throwIfAborted();
      await git.assertReady(workflowSignal);
      if (state.root !== this.loaded.root || state.configPath !== this.loaded.path) {
        throw new Error("Run checkpoint belongs to a different project configuration");
      }
      checkpoint = latestCheckpoint(state);
      await this.assertCheckpointMatches(state, checkpoint, git);
      await this.reconcilePostCheckpointMerges(state, checkpoint, git, store);
      if (options.mode === "approval") {
        const approval = latestApproval(state, "plan");
        if (approval?.status !== "approved" || approval.checkpointId !== checkpoint.id) {
          throw new Error("Plan approval does not match the latest checkpoint");
        }
        delete state.error;
        if (options.supervisorId) state.supervisorId = options.supervisorId;
        await store.save(state);
        store.emit(state.id, "run.continuation-started", {
          mode: options.mode,
          actor: options.actor,
          checkpointId: checkpoint.id,
        });
      } else {
        await this.prepareRecovery(state, checkpoint, store, options);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      await store.save(state);
      await this.recordExecutionSegment(state, store, segmentStartedAt);
      return state;
    }
    try {
      return await this.continueFromCheckpoint(
        state,
        checkpoint,
        store,
        git,
        agent,
        budget,
        workflowSignal,
      );
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      // A user pause settles as interrupted (resumable) instead of cancelled
      // and keeps task worktrees, so quality-passed tasks can be reused by
      // resume. The pause is recognized by its deterministic abort message
      // rather than a state flag, which could be overwritten by a racing save.
      const paused = /paused by user/i.test(state.error);
      await store.transition(
        state,
        terminalStatusAfterFailure(error, workflowSignal),
        state.error,
      );
      if (!paused) {
        await this.experience.extractFromRun(state, store);
        await this.cleaner.cleanup(state, store, git);
      }
      return state;
    } finally {
      deadline.dispose();
      await this.recordExecutionSegment(state, store, segmentStartedAt);
    }
  }

  private async continueFromCheckpoint(
    state: RunState,
    checkpoint: RunCheckpoint,
    store: RunStateStore,
    git: GitManager,
    agent: RoleAgentService,
    budget: RunBudgetTracker,
    signal?: AbortSignal,
  ): Promise<RunState> {
    if (checkpoint.stage === "local-gates-passed") {
      const finalApproval = latestApproval(state, "final");
      if (!finalApproval || finalApproval.checkpointId !== checkpoint.id) {
        await this.requestApproval(
          state,
          store,
          checkpoint,
          "final",
          "All local gates passed; approve the integration result before publication",
        );
      }
      return state;
    }
    if (checkpoint.stage !== "tasks-complete") {
      await this.executeTasks(state, store, git, agent, budget, signal);
      await this.recordCheckpoint(state, store, git, "tasks-complete");
    }

    await store.transition(state, "final-checks", "Running integration quality commands");
    await this.prepareWorktreeDependencies(
      state.integrationWorktree,
      signal,
      state.strategy.maxProcessOutputBytes,
    );
    state.finalQuality = await runQualityCommands(
      state.integrationWorktree,
      this.loaded.config.quality.commands,
      this.loaded.config.quality.commandTimeoutSeconds,
      store.artifactDirectory(state.id, recoveryArtifactKey(state, "final-quality")),
      signal,
      { maxOutputBytes: state.strategy.maxProcessOutputBytes },
    );
    await budget.recordQuality(state.finalQuality);
    await store.save(state);

    // A failing integration gate already vetoes delivery, so advice would only
    // spend budget; consult the architect only when there is something to ship.
    const preFinalAdvice = state.finalQuality.passed
      ? await this.consultAdvisor({
          state,
          store,
          agent,
          trigger: "pre-final",
          cwd: state.integrationWorktree,
          artifactKey: recoveryArtifactKey(state, "pre-final-advisor"),
          ...(signal ? { signal } : {}),
          context: {
            trigger: "pre-final",
            goal: state.goal,
            planSummary: state.plan?.summary,
            tasks: state.tasks.map((task) => ({
              id: task.task.id,
              title: task.task.title,
              status: task.status,
            })),
            diffStat: await git.diffSummary(state.integrationWorktree, state.baseCommit).catch(() => ""),
            finalQuality: compactQuality(state.finalQuality),
          },
        })
      : undefined;

    const finalDecision = await agent.runStructured({
      role: "orchestrator",
      promptKey: "orchestrator-final",
      cwd: state.integrationWorktree,
      runId: state.id,
      artifactKey: recoveryArtifactKey(state, "final-decision"),
      context: {
        goal: state.goal,
        planSummary: state.plan?.summary,
        tasks: state.tasks.map((task) => ({
          id: task.task.id,
          status: task.status,
          qualityPassed: task.quality?.passed,
          review: task.review,
          test: task.test,
        })),
        finalQuality: compactQuality(state.finalQuality),
        ...(preFinalAdvice ? { preFinalAdvice } : {}),
      },
      schema: finalDecisionSchema,
      jsonSchema: finalDecisionJsonSchema,
    });
    state.finalDecision = finalDecision.value;

    const mergedTasks = state.tasks.filter((task) => task.status === "merged");
    const qualityPassedWithMergedWork = state.finalQuality.passed && mergedTasks.length > 0;
    if (!state.finalQuality.passed || (finalDecision.value.decision !== "ready" && !qualityPassedWithMergedWork)) {
      throw new Error(
        !state.finalQuality.passed
          ? formatQualityFailure("Integration quality commands failed", state.finalQuality)
          : `Supervising agent escalated: ${finalDecision.value.reason}`,
      );
    }
    if (qualityPassedWithMergedWork && finalDecision.value.decision !== "ready") {
      state.history.push({
        at: new Date().toISOString(),
        status: "final-checks",
        message: `终裁 escalate 已降级：质量门已过且 ${mergedTasks.map((task) => task.task.id).join(", ")} 已合并。${finalDecision.value.reason}`,
      });
    }
    const finalCheckpoint = await this.recordCheckpoint(
      state,
      store,
      git,
      "local-gates-passed",
    );
    if (state.purpose === "evolution-evaluation") {
      await store.transition(
        state,
        "completed",
        "Automatic evolution evaluation completed without publication",
      );
      await this.experience.extractFromRun(state, store);
      await this.cleaner.cleanup(state, store, git);
      return state;
    }
    const blockedAfterChecks = state.tasks.filter((task) => task.status === "blocked");
    await this.requestApproval(
      state,
      store,
      finalCheckpoint,
      "final",
      blockedAfterChecks.length > 0
        ? `Local gates passed for merged tasks; ${blockedAfterChecks.map((task) => task.task.id).join(", ")} remain blocked`
        : "All local gates passed; approve the integration result before publication",
    );
    return state;
  }

  private async recordCheckpoint(
    state: RunState,
    store: RunStateStore,
    git: GitManager,
    stage: CheckpointStage,
  ): Promise<RunCheckpoint> {
    const checkpoint: RunCheckpoint = {
      id: randomUUID(),
      version: 1,
      stage,
      integrationCommit: await git.currentCommit(state.integrationWorktree),
      completedTaskIds: state.tasks
        .filter((task) => task.status === "merged")
        .map((task) => task.task.id)
        .sort(),
      createdAt: new Date().toISOString(),
    };
    state.checkpoints = [...(state.checkpoints ?? []), checkpoint];
    await store.save(state);
    store.emit(state.id, "workflow.checkpoint", checkpoint);
    return checkpoint;
  }

  private async requestApproval(
    state: RunState,
    store: RunStateStore,
    checkpoint: RunCheckpoint,
    gate: ApprovalRequest["gate"],
    summary: string,
  ): Promise<ApprovalRequest> {
    const requestedAt = new Date();
    const approval: ApprovalRequest = {
      id: randomUUID(),
      gate,
      status: "pending",
      summary,
      checkpointId: checkpoint.id,
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(
        requestedAt.getTime() + state.strategy.approvalTimeoutSeconds * 1_000,
      ).toISOString(),
    };
    state.approvals = [...(state.approvals ?? []), approval];
    await store.transition(state, "awaiting-human", summary);
    store.emit(state.id, "approval.requested", approval);
    return approval;
  }

  private async assertCheckpointMatches(
    state: RunState,
    checkpoint: RunCheckpoint,
    git: GitManager,
  ): Promise<void> {
    const integrationCommit = await git.currentCommit(state.integrationWorktree);
    if (integrationCommit !== checkpoint.integrationCommit) {
      if (!(await this.isOnlyPostCheckpointMerges(state, checkpoint, git))) {
        throw new Error(
          `Integration worktree HEAD '${integrationCommit}' does not match checkpoint '${checkpoint.integrationCommit}'`,
        );
      }
    }
    if (!(await git.isClean(state.integrationWorktree))) {
      throw new Error("Integration worktree has uncommitted changes outside the checkpoint");
    }
    const knownTasks = new Set(state.tasks.map((task) => task.task.id));
    for (const taskId of checkpoint.completedTaskIds) {
      if (!knownTasks.has(taskId)) {
        throw new Error(`Checkpoint references unknown task '${taskId}'`);
      }
    }
  }

  /**
   * Tolerate a crash between a task merge and the wave checkpoint: the
   * integration HEAD may sit exactly on the recorded merge commits of tasks
   * that are marked merged but absent from the checkpoint, plus merge commits
   * for tasks whose `merging` intent was persisted before the Git merge.
   * Anything else (foreign commits, missing records, divergence) keeps the
   * refusal. A `merging` marker without a matching merge commit simply means
   * the crash happened before the merge and needs no tolerance here.
   */
  private async isOnlyPostCheckpointMerges(
    state: RunState,
    checkpoint: RunCheckpoint,
    git: GitManager,
  ): Promise<boolean> {
    const checkpointed = new Set(checkpoint.completedTaskIds);
    const expected = new Set(
      state.tasks
        .filter(
          (task) =>
            task.status === "merged" &&
            !checkpointed.has(task.task.id) &&
            typeof task.mergeCommit === "string",
        )
        .map((task) => task.mergeCommit!),
    );
    const mergingTasks = state.tasks.filter(
      (task) => !checkpointed.has(task.task.id) && typeof task.merging === "string",
    );
    if (expected.size === 0 && mergingTasks.length === 0) {
      return false;
    }
    const extras = await git.commitsBetween(
      state.integrationWorktree,
      checkpoint.integrationCommit,
      "HEAD",
    );
    const subjects =
      mergingTasks.length > 0
        ? await git.commitSubjects(state.integrationWorktree, checkpoint.integrationCommit, "HEAD")
        : new Map<string, string>();
    const unmatchedSubjects = new Map<string, boolean>(
      mergingTasks.map((task) => [`merge: ${task.task.id} ${task.task.title}`, true]),
    );
    for (const commit of extras) {
      if (expected.has(commit)) {
        continue;
      }
      const subject = subjects.get(commit);
      if (!subject || !unmatchedSubjects.has(subject)) {
        return false;
      }
      unmatchedSubjects.delete(subject);
    }
    return true;
  }

  /**
   * Complete merges whose state save crashed. Tasks with a persisted
   * `merging` marker get their merge commit back from the deterministic
   * commit subject; a marker without a matching merge means the crash
   * happened before `git merge`, so the marker is cleared and the task
   * merges normally during recovery.
   */
  private async reconcilePostCheckpointMerges(
    state: RunState,
    checkpoint: RunCheckpoint,
    git: GitManager,
    store: RunStateStore,
  ): Promise<void> {
    const mergingTasks = state.tasks.filter((task) => typeof task.merging === "string");
    if (mergingTasks.length === 0) {
      return;
    }
    const subjects = await git.commitSubjects(
      state.integrationWorktree,
      checkpoint.integrationCommit,
      "HEAD",
    );
    let changed = false;
    for (const task of mergingTasks) {
      const expectedSubject = `merge: ${task.task.id} ${task.task.title}`;
      const mergedCommit = [...subjects.entries()].find(
        ([, subject]) => subject === expectedSubject,
      )?.[0];
      delete task.merging;
      changed = true;
      if (mergedCommit) {
        // A matching subject alone is not enough: verify the merge commit's
        // second parent is the task commit this orchestrator recorded, so a
        // foreign commit that happens to reuse the subject still refuses.
        const secondParent = await git
          .resolveCommit(`${mergedCommit}^2`)
          .catch(() => undefined);
        if (typeof task.commit !== "string" || secondParent !== task.commit) {
          throw new Error(
            `Merge commit '${mergedCommit}' for task '${task.task.id}' does not point at the recorded task commit`,
          );
        }
        task.mergeCommit = mergedCommit;
        task.status = "merged";
        if (task.worktree) {
          try {
            await git.removeWorktree(task.worktree);
          } catch {
            // Leftover task worktrees are best-effort; terminal cleanup
            // removes anything that survives.
          }
        }
      }
    }
    if (changed) {
      await store.save(state);
    }
  }

  private async prepareRecovery(
    state: RunState,
    checkpoint: RunCheckpoint,
    store: RunStateStore,
    options: WorkflowResumeOptions,
  ): Promise<void> {
    if (state.status !== "interrupted") {
      throw new Error(`Run '${state.id}' cannot recover from status '${state.status}'`);
    }
    if (
      checkpoint.stage === "plan-ready" &&
      requiresPlanApproval(state)
    ) {
      const planApproval = latestApproval(state, "plan");
      if (
        planApproval?.status !== "approved" ||
        planApproval.checkpointId !== checkpoint.id
      ) {
        throw new Error("Plan checkpoint requires approval before worker recovery");
      }
    }
    const completed = new Set(checkpoint.completedTaskIds);
    const abandonedTasks: RecoveryRecord["abandonedTasks"] = [];
    let abandonedIncomplete = false;
    for (const task of state.tasks) {
      if (completed.has(task.task.id)) {
        if (task.status !== "merged") {
          throw new Error(`Checkpointed task '${task.task.id}' is not marked merged`);
        }
        continue;
      }
      if (task.status === "merged") {
        // Merged into the integration branch after the latest checkpoint was
        // recorded (e.g. a crash mid-integration). The work is already done;
        // never reset or redo it.
        continue;
      }
      if (task.status === "passed" && task.commit && task.branch && task.worktree) {
        // Quality and review already landed a task commit. Keep the worktree
        // so resume can merge it instead of paying for another worker wave.
        continue;
      }
      if (task.quality?.passed && task.branch && task.worktree) {
        // Worker and quality already finished. Keep the worktree so resume
        // can review or commit instead of paying for another implementation.
        continue;
      }
      if (task.status !== "pending") {
        abandonedIncomplete = true;
        abandonedTasks.push({
          taskId: task.task.id,
          status: task.status,
          attempts: task.attempts,
          ...(task.branch ? { branch: task.branch } : {}),
          ...(task.worktree ? { worktree: task.worktree } : {}),
          ...(task.commit ? { commit: task.commit } : {}),
        });
      }
      resetIncompleteTask(task);
    }
    if (abandonedIncomplete) {
      state.resumeCount = (state.resumeCount ?? 0) + 1;
    }
    state.recoveries = [
      ...(state.recoveries ?? []),
      {
        at: new Date().toISOString(),
        actor: options.actor,
        reason: options.reason,
        checkpointId: checkpoint.id,
        abandonedTasks,
      },
    ];
    delete state.error;
    if (options.supervisorId) state.supervisorId = options.supervisorId;
    await store.transition(
      state,
      checkpoint.stage === "local-gates-passed" || checkpoint.stage === "tasks-complete"
        ? "final-checks"
        : "planned",
      `Recovered checkpoint ${checkpoint.id} by ${options.actor}`,
    );
    store.emit(state.id, "run.recovered", state.recoveries.at(-1));
  }

  private async executeTasks(
    state: RunState,
    store: RunStateStore,
    git: GitManager,
    agent: RoleAgentService,
    budget: RunBudgetTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!state.plan) {
      throw new Error("Cannot execute tasks without a plan");
    }
    const checkpoint = latestCheckpoint(state);
    const completed = new Set(checkpoint.completedTaskIds);
    // Tasks merged after the latest checkpoint was recorded (crash
    // mid-integration) are already done; their commits live on the
    // integration branch and must not be redone.
    for (const task of state.tasks) {
      if (task.status === "merged") {
        completed.add(task.task.id);
      }
    }
    const alreadyPassed = state.tasks.filter(
      (task) =>
        task.status === "passed" &&
        !completed.has(task.task.id) &&
        Boolean(task.branch) &&
        Boolean(task.worktree) &&
        Boolean(task.commit),
    );
    if (alreadyPassed.length > 0) {
      await store.transition(state, "integrating", "合并中断前已通过质量门的任务");
      for (const taskState of alreadyPassed.sort((left, right) =>
        left.task.id.localeCompare(right.task.id),
      )) {
        signal?.throwIfAborted();
        if (!taskState.branch || !taskState.worktree) {
          throw new Error(`Task '${taskState.task.id}' has no branch/worktree metadata`);
        }
        // Same crash-window protection as the wave merge loop: persist the
        // merge intent before the Git side effect so recovery can match the
        // deterministic merge-commit subject.
        taskState.merging = taskState.branch;
        await store.save(state);
        taskState.mergeCommit = await git.merge(
          state.integrationWorktree,
          taskState.branch,
          `merge: ${taskState.task.id} ${taskState.task.title}`,
          signal,
        );
        taskState.status = "merged";
        delete taskState.merging;
        completed.add(taskState.task.id);
        try {
          await git.removeWorktree(taskState.worktree, signal);
        } catch (error) {
          await this.cleaner.warn(
            state,
            store,
            `Failed to remove task worktree '${taskState.worktree}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        await store.save(state);
      }
      await this.recordCheckpoint(state, store, git, "task-wave-integrated");
    }
    const started = new Set(completed);
    const blockedIds = new Set(
      state.tasks.filter((task) => task.status === "blocked").map((task) => task.task.id),
    );
    for (const id of blockedIds) {
      started.add(id);
    }

    while (completed.size + blockedIds.size < state.plan.tasks.length) {
      signal?.throwIfAborted();
      const concurrency = state.strategy.swarmMaxConcurrency ?? state.strategy.maxParallel;
      const wave = selectTaskWave(
        state.plan,
        completed,
        started,
        concurrency,
      );
      if (wave.length === 0) {
        const remaining = state.plan.tasks.filter(
          (task) => !completed.has(task.id) && !blockedIds.has(task.id),
        );
        if (remaining.length === 0) {
          break;
        }
        for (const task of remaining) {
          const taskState = findTaskState(state, task.id);
          taskState.status = "blocked";
          taskState.error = "Blocked because a dependency failed";
          blockedIds.add(task.id);
        }
        await store.save(state);
        break;
      }
      for (const task of wave) {
        started.add(task.id);
      }
      const waveTaskIds = wave.map((task) => task.id);
      const batchKeys = [
        ...new Set(wave.map((task) => task.batchKey).filter((key): key is string => Boolean(key))),
      ];
      store.emit(state.id, "run.wave.started", {
        taskIds: waveTaskIds,
        concurrency: wave.length,
        maxParallel: state.strategy.maxParallel,
        swarmMaxConcurrency: concurrency,
        batchKeys,
      });
      await store.transition(
        state,
        "implementing",
        `启动执行波次（Swarm）：${waveTaskIds.join(", ")} · 并发 ${wave.length}/${concurrency}`,
      );

      const integrationCommit = await git.currentCommit(state.integrationWorktree, signal);
      // Tasks in a wave are independent. A sibling failure must not abort
      // work that already passed quality gates.
      const waveSignal = signal;
      const waveProfileOverrides = {
        ...state.strategy.roleProfiles,
        ...state.profileOverrides,
      };
      const waveAgent = this.dependencies.createAgentService
        ? this.dependencies.createAgentService(store, waveProfileOverrides, waveSignal)
        : new ProfiledAgentService(
            this.loaded.config,
            this.loaded.root,
            store,
            waveProfileOverrides,
            waveSignal,
            budget,
          );
      const results = await Promise.allSettled(
        wave.map(async (task) => {
          const taskState = findTaskState(state, task.id);
          const reuseWorktree = await this.canReusePassedWorktree(taskState);
          if (!reuseWorktree) {
            const recoverySuffix = state.resumeCount ? `-resume-${state.resumeCount}` : "";
            const taskSegment = `${branchSegment(task.id)}${recoverySuffix}`;
            const branch = `agent-team/${branchSegment(state.id)}/${taskSegment}`;
            const worktree = path.join(this.worktreesDirectory, state.id, taskSegment);
            taskState.branch = branch;
            taskState.worktree = worktree;
            taskState.status = "working";
            await git.createWorktree(branch, integrationCommit, worktree, waveSignal);
            await this.prepareWorktreeDependencies(
              worktree,
              waveSignal,
              state.strategy.maxProcessOutputBytes,
            );
            await store.save(state);
          }
          await this.executeOneTask(state, taskState, store, git, waveAgent, budget, waveSignal);
          return taskState;
        }),
      );
      const taskStates = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const rejection = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      const passedStates = taskStates.filter((task) => task.status === "passed");
      const blocked = taskStates.filter((task) => task.status === "blocked");
      store.emit(state.id, "run.wave.completed", {
        taskIds: waveTaskIds,
        concurrency: wave.length,
        status:
          rejection && passedStates.length === 0 && blocked.length === 0
            ? "failed"
            : blocked.length > 0
              ? "blocked"
              : "passed",
        ...(rejection
          ? {
              error:
                rejection.reason instanceof Error
                  ? rejection.reason.message
                  : String(rejection.reason),
            }
          : {}),
        ...(blocked[0] ? { blockedTaskId: blocked[0].task.id } : {}),
        batchKeys,
      });
      if (rejection && passedStates.length === 0 && blocked.length === 0) {
        throw rejection.reason;
      }

      for (const task of blocked) {
        blockedIds.add(task.task.id);
      }

      await store.transition(state, "integrating", "合并本波次通过的任务");
      for (const taskState of passedStates.sort((left, right) => left.task.id.localeCompare(right.task.id))) {
        signal?.throwIfAborted();
        if (!taskState.branch || !taskState.worktree) {
          throw new Error(`Task '${taskState.task.id}' has no branch/worktree metadata`);
        }
        // Persist the merge intent before the Git side effect: a crash after
        // the merge but before the next save is then recoverable by matching
        // the deterministic merge-commit subject during resume.
        taskState.merging = taskState.branch;
        await store.save(state);
        taskState.mergeCommit = await git.merge(
          state.integrationWorktree,
          taskState.branch,
          `merge: ${taskState.task.id} ${taskState.task.title}`,
          signal,
        );
        taskState.status = "merged";
        delete taskState.merging;
        completed.add(taskState.task.id);
        try {
          await git.removeWorktree(taskState.worktree, signal);
        } catch (error) {
          // Worktree cleanup failure must not block an otherwise passing wave.
          await this.cleaner.warn(
            state,
            store,
            `Failed to remove task worktree '${taskState.worktree}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        await store.save(state);
      }
      store.emit(state.id, "run.wave.completed", {
        taskIds: waveTaskIds,
        concurrency: wave.length,
        status: "merged",
        batchKeys,
      });
      await this.recordCheckpoint(state, store, git, "task-wave-integrated");
    }

    const leftoverBlocked = state.tasks.filter((task) => task.status === "blocked");
    const merged = state.tasks.filter((task) => task.status === "merged");
    if (leftoverBlocked.length > 0 && merged.length === 0) {
      throw new Error(
        `Task '${leftoverBlocked[0]!.task.id}' blocked: ${leftoverBlocked[0]!.error ?? "unknown error"}`,
      );
    }
    if (leftoverBlocked.length > 0) {
      await store.transition(
        state,
        "integrating",
        `部分任务已合并，${leftoverBlocked.map((task) => task.task.id).join(", ")} 仍阻塞`,
      );
    }
  }

  private async maybeExplore(
    state: RunState,
    store: RunStateStore,
    agent: RoleAgentService,
    goal: string,
    baseCommit: string,
    verifiedExperiences: unknown,
  ): Promise<ExploreSummary | undefined> {
    const explore = state.strategy.explore;
    if (!explore?.enabled) {
      return undefined;
    }

    await store.transition(state, "exploring", "技术研究员只读调研代码库（explore）");
    const exploreRole = this.loaded.config.roles.researcher ? "researcher" : "architect";
    store.emit(state.id, "run.explore.started", {
      role: exploreRole,
      profile:
        explore.profile
        ?? state.strategy.roleProfiles.researcher
        ?? state.strategy.roleProfiles.architect
        ?? null,
      maxInjectedChars: explore.maxInjectedChars,
      failOpen: explore.failOpen,
    });

    try {
      const result = await agent.runStructured({
        role: exploreRole,
        runId: state.id,
        artifactKey: "explore",
        ...(explore.profile ? { profileName: explore.profile } : {}),
        context: {
          mode: "explore-only",
          goal,
          intake: state.intake,
          project: this.loaded.config.project,
          baseCommit,
          instructions: [
            "Read-only technical research before task planning.",
            "Do not propose file edits or commits.",
            "Return a structured summary of modules, risks, and constraints.",
          ],
          ...(verifiedExperiences ? { verifiedExperiences } : {}),
        },
        schema: exploreSummarySchema,
        jsonSchema: exploreSummaryJsonSchema,
      });

      const summary = result.value;
      const artifactDir = store.artifactDirectory(state.id, "explore");
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        path.join(artifactDir, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
      );

      const injected = truncateExploreSummary(summary, explore.maxInjectedChars);
      store.emit(state.id, "run.explore.completed", {
        success: true,
        profile: result.profileName,
        injectedChars: JSON.stringify(injected).length,
      });
      await store.transition(
        state,
        "exploring",
        `探索完成：${summary.summary.slice(0, 120)}${summary.summary.length > 120 ? "…" : ""}`,
      );
      return injected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.emit(state.id, "run.explore.completed", {
        success: false,
        error: message,
        failOpen: explore.failOpen,
      });
      if (explore.failOpen) {
        await store.transition(
          state,
          "exploring",
          `探索失败已跳过（failOpen）：${message.slice(0, 160)}`,
        );
        return undefined;
      }
      throw error;
    }
  }

  private async executeOneTask(
    state: RunState,
    taskState: TaskRunState,
    store: RunStateStore,
    git: GitManager,
    agent: RoleAgentService,
    budget: RunBudgetTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!taskState.worktree || !state.plan) {
      throw new Error(`Task '${taskState.task.id}' worktree is not initialized`);
    }
    const maxAttempts = state.strategy.maxReworkAttempts + 1;
    let feedback = "";
    let lastReworkExperienceIds: string[] = [];
    let failureInput: FailureSignatureInput | undefined;
    let previousSignature: FailureSignature | undefined;
    let architectAdvice: AdvisorVerdict | undefined;
    const reused = await this.tryFinishAlreadyPassedTask(
      state,
      taskState,
      store,
      git,
      agent,
      signal,
    );
    if (reused === "committed") {
      return;
    }
    if (reused === "rework") {
      feedback = taskState.error ?? "Previous review requested changes";
    }
    // Attempt counts persist across resume segments: a task interrupted at
    // attempt N continues at N+1, and a task that already exhausted its
    // rework limit stays blocked instead of being granted a fresh budget.
    const priorAttempts = Math.max(taskState.attempts, 0);
    const startAttempt =
      reused === "rework"
        ? Math.min(priorAttempts + 1, maxAttempts)
        : priorAttempts > 0
          ? priorAttempts + 1
          : 1;
    if (startAttempt > maxAttempts) {
      taskState.status = "blocked";
      taskState.error = `Rework attempts exhausted: ${priorAttempts} attempt(s) against limit ${state.strategy.maxReworkAttempts}`;
      await store.save(state);
      return;
    }

    for (let attempt = startAttempt; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      if (failureInput) {
        // Deterministic fork: the same normalized failure twice in a row means
        // a blind retry is unlikely to help, so escalate to the architect.
        const currentSignature = computeFailureSignature(failureInput);
        const repeated = isRepeatedFailure(previousSignature, currentSignature);
        previousSignature = currentSignature;
        failureInput = undefined;
        architectAdvice = undefined;
        let consult = repeated;
        let escalatedBy: "jev" | undefined;
        if (this.forkAdvisor && this.canConsultAdvisor(state, "repeated-failure")) {
          const resolution = await this.decideWithFork(state, store, {
            taskId: taskState.task.id,
            taskTitle: taskState.task.title,
            attempt,
            maxAttempts,
            repeated,
            failureSummary: currentSignature.summary,
            ...(signal ? { signal } : {}),
          });
          consult = resolution.consult;
          if (consult && !repeated) {
            escalatedBy = "jev";
          }
        }
        if (consult) {
          const verdict = await this.consultAdvisor({
            state,
            store,
            agent,
            trigger: "repeated-failure",
            taskId: taskState.task.id,
            cwd: taskState.worktree,
            artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "advisor"),
            ...(signal ? { signal } : {}),
            context: {
              trigger: "repeated-failure",
              goal: state.goal,
              planSummary: state.plan.summary,
              task: taskState.task,
              attempt,
              repeatedFailure: currentSignature.summary,
              repeated,
              ...(escalatedBy ? { escalatedBy } : {}),
              feedback: feedback.slice(-20_000),
              diff: await git.stagedDiff(taskState.worktree, 60_000, signal).catch(() => ""),
            },
          });
          if (verdict?.recommendation === "stop") {
            taskState.status = "blocked";
            taskState.error = `Architect advisor stopped the task after a repeated failure: ${verdict.summary}`;
            await store.save(state);
            return;
          }
          architectAdvice = verdict;
        }
      }
      taskState.attempts = attempt;
      taskState.status = attempt === 1 ? "working" : "reworking";
      await store.save(state);
      try {
        const reworkExperiences =
          attempt > 1 && feedback
            ? await this.experience.loadRework(state, store, {
                feedback,
                taskId: taskState.task.id,
                taskTitle: taskState.task.title,
              })
            : undefined;
        lastReworkExperienceIds = reworkExperiences?.items.map((item) => item.id) ?? [];
        const worker = await agent.runText({
          role: "worker",
          cwd: taskState.worktree,
          runId: state.id,
          artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "worker"),
          ...(taskState.task.profile ? { profileName: taskState.task.profile } : {}),
          context: {
            goal: state.goal,
            planSummary: state.plan.summary,
            task: taskState.task,
            attempt,
            feedback,
            ...(reworkExperiences ? { verifiedFailureExperiences: reworkExperiences } : {}),
            ...(architectAdvice ? { architectAdvice } : {}),
          },
        });
        taskState.profile = worker.profileName;

        const quality = await this.runTaskQualityGates(
          state,
          taskState,
          taskState.worktree,
          store,
          budget,
          attempt,
          signal,
        );

        await git.stage(taskState.worktree, signal);
        const files = await git.changedFiles(taskState.worktree, signal);
        if (files.length === 0) {
          feedback = "No repository changes were produced. Implement the assigned task.";
          failureInput = { quality, errorMessage: feedback };
          await this.experience.recordAttempt(state, store, taskState, attempt, feedback);
          continue;
        }
        try {
          git.assertOwnedPaths(files, taskState.task.ownedPaths);
        } catch (error) {
          feedback = error instanceof Error ? error.message : String(error);
          failureInput = { quality, errorMessage: feedback };
          await this.experience.recordAttempt(state, store, taskState, attempt, feedback);
          continue;
        }
        const diff = await git.stagedDiff(taskState.worktree, 160_000, signal);
        const { review, test } = await this.reviewTaskAttempt(
          state,
          taskState,
          taskState.worktree,
          store,
          agent,
          quality,
          files,
          diff,
          attempt,
        );

        if (
          quality.passed
          && (
            passesTaskGates(quality, review, test)
            || shouldTrustQualityOverReview(review, test)
            || shouldAcceptDocsDespiteEscalate(taskState.task, review, test)
          )
        ) {
          if (attempt > 1 && lastReworkExperienceIds.length > 0) {
            await this.experience.recordSuccess(state, store, lastReworkExperienceIds);
          }
          await this.commitPassedTask(state, taskState, taskState.worktree, store, git, signal);
          return;
        }
        if (isHardSpecialistEscalation(review, test) && !quality.passed) {
          throw new Error(
            `Specialist escalated task: ${review.summary}; ${test.summary}`,
          );
        }
        feedback = buildReworkFeedback(quality, review, test);
        failureInput = { quality, review, test };
        await this.experience.recordAttempt(state, store, taskState, attempt, feedback);
        await store.transition(
          state,
          "reworking",
          `Task ${taskState.task.id} failed gates on attempt ${attempt}`,
        );
      } catch (error) {
        if (error instanceof RunBudgetExceededError || signal?.aborted) {
          // Budget exhaustion and aborts are control-plane signals, not
          // rework feedback; never spin them into further attempts.
          throw error;
        }
        feedback = error instanceof Error ? error.message : String(error);
        failureInput = { errorMessage: feedback };
        await this.experience.recordAttempt(state, store, taskState, attempt, feedback);
        if (feedback.startsWith("Specialist escalated")) {
          taskState.status = "blocked";
          taskState.error = feedback;
          await store.save(state);
          return;
        }
      }
    }

    taskState.status = "blocked";
    taskState.error = `Exceeded ${maxAttempts} attempt(s): ${feedback}`;
    await store.save(state);
  }

  private canConsultAdvisor(state: RunState, trigger: AdvisorTrigger): boolean {
    const advisor = state.strategy.advisor;
    return Boolean(
      advisor?.enabled &&
        advisor.triggers.includes(trigger) &&
        (state.advisorConsultations ?? 0) < advisor.maxConsultationsPerRun,
    );
  }

  /**
   * Ask the local fork model whether to escalate now. Advisory only: it can
   * bring the architect forward, never skip a required consultation or change any check result, and
   * any failure or low confidence keeps the deterministic decision.
   */
  private async decideWithFork(
    state: RunState,
    store: RunStateStore,
    input: JevDecisionInput & { signal?: AbortSignal },
  ): Promise<ConsultationResolution> {
    const { signal, ...request } = input;
    const startedAt = Date.now();
    let decision: JevDecision | undefined;
    try {
      decision = await this.forkAdvisor?.decide(request, signal);
    } catch {
      decision = undefined;
    }
    signal?.throwIfAborted();
    const minConfidence = this.loaded.config.jev?.minConfidence ?? 0.8;
    const resolution = resolveConsultation({
      repeated: request.repeated,
      jev: decision,
      minConfidence,
    });
    store.emit(state.id, "run.jev.decided", {
      taskId: request.taskId,
      attempt: request.attempt,
      repeated: request.repeated,
      ...(decision
        ? { decision: decision.decision, confidence: decision.confidence }
        : {}),
      source: resolution.source,
      consult: resolution.consult,
      changedOutcome: resolution.consult !== request.repeated,
      reason: resolution.reason,
      latencyMs: Date.now() - startedAt,
    });
    return resolution;
  }

  /**
   * Consult the on-call architect. Read-only: the verdict is advice injected
   * into later context and never overrides deterministic checks. Returns
   * undefined when disabled, out of budget, or when the consultation failed
   * (fail-open). Budget exhaustion and aborts are never swallowed.
   */
  private async consultAdvisor(options: {
    state: RunState;
    store: RunStateStore;
    agent: RoleAgentService;
    trigger: AdvisorTrigger;
    taskId?: string;
    cwd: string;
    artifactKey: string;
    context: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<AdvisorVerdict | undefined> {
    const { state, store, agent, trigger, taskId } = options;
    const advisor = state.strategy.advisor;
    if (!advisor?.enabled || !advisor.triggers.includes(trigger)) {
      return undefined;
    }
    const used = state.advisorConsultations ?? 0;
    if (used >= advisor.maxConsultationsPerRun) {
      store.emit(state.id, "run.advisor.skipped", {
        trigger,
        ...(taskId ? { taskId } : {}),
        reason: "consultation-limit",
        used,
        limit: advisor.maxConsultationsPerRun,
      });
      return undefined;
    }
    // Count before invoking so an interrupted consultation still spends quota
    // and resume cannot loop on it indefinitely.
    state.advisorConsultations = used + 1;
    await store.save(state);
    try {
      const response = await agent.runStructured({
        role: "architect",
        promptKey: "architect-advisor",
        cwd: options.cwd,
        runId: state.id,
        artifactKey: options.artifactKey,
        ...(advisor.profile ? { profileName: advisor.profile } : {}),
        context: options.context,
        schema: advisorVerdictSchema,
        jsonSchema: advisorVerdictJsonSchema,
      });
      store.emit(state.id, "run.advisor.consulted", {
        trigger,
        ...(taskId ? { taskId } : {}),
        profile: response.profileName,
        usedFallback: response.usedFallback,
        recommendation: response.value.recommendation,
        summary: response.value.summary,
        used: used + 1,
        limit: advisor.maxConsultationsPerRun,
      });
      return response.value;
    } catch (error) {
      if (error instanceof RunBudgetExceededError || isBudgetExceededError(error)) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      store.emit(state.id, "run.advisor.failed", {
        trigger,
        ...(taskId ? { taskId } : {}),
        error: message.slice(0, 500),
      });
      return undefined;
    }
  }

  private async canReusePassedWorktree(taskState: TaskRunState): Promise<boolean> {
    return Boolean(
      taskState.quality?.passed &&
        taskState.branch &&
        taskState.worktree &&
        (await pathExists(taskState.worktree)),
    );
  }

  private async tryFinishAlreadyPassedTask(
    state: RunState,
    taskState: TaskRunState,
    store: RunStateStore,
    git: GitManager,
    agent: RoleAgentService,
    signal?: AbortSignal,
  ): Promise<"committed" | "rework" | "fresh"> {
    if (!(await this.canReusePassedWorktree(taskState)) || !taskState.worktree) {
      return "fresh";
    }
    if (taskState.commit) {
      taskState.status = "passed";
      await store.save(state);
      return "committed";
    }
    await git.stage(taskState.worktree, signal);
    const files = await git.changedFiles(taskState.worktree, signal);
    if (files.length === 0) {
      return "fresh";
    }
    try {
      git.assertOwnedPaths(files, taskState.task.ownedPaths);
    } catch {
      return "fresh";
    }
    const attempt = Math.max(taskState.attempts, 1);
    const diff = await git.stagedDiff(taskState.worktree, 160_000, signal);
    const quality = taskState.quality!;
    if (
      taskState.review &&
      taskState.test &&
      (passesTaskGates(quality, taskState.review, taskState.test) ||
        shouldTrustQualityOverReview(taskState.review, taskState.test) ||
        shouldAcceptDocsDespiteEscalate(taskState.task, taskState.review, taskState.test))
    ) {
      await this.commitPassedTask(state, taskState, taskState.worktree, store, git, signal);
      return "committed";
    }
    const { review, test } = await this.reviewTaskAttempt(
      state,
      taskState,
      taskState.worktree,
      store,
      agent,
      quality,
      files,
      diff,
      attempt,
    );
    if (
      quality.passed &&
      (passesTaskGates(quality, review, test) ||
        shouldTrustQualityOverReview(review, test) ||
        shouldAcceptDocsDespiteEscalate(taskState.task, review, test))
    ) {
      await this.commitPassedTask(state, taskState, taskState.worktree, store, git, signal);
      return "committed";
    }
    if (isHardSpecialistEscalation(review, test) && !quality.passed) {
      return "fresh";
    }
    taskState.status = "reworking";
    taskState.error = buildReworkFeedback(quality, review, test);
    await store.save(state);
    return "rework";
  }

  private async prepareWorktreeDependencies(
    worktree: string,
    signal: AbortSignal | undefined,
    maxOutputBytes: number | undefined,
  ): Promise<void> {
    await ensureWorktreeNodeModules(worktree, {
      timeoutSeconds: this.loaded.config.quality.commandTimeoutSeconds,
      ...(signal ? { signal } : {}),
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
    });
  }

  private async runTaskQualityGates(
    state: RunState,
    taskState: TaskRunState,
    worktree: string,
    store: RunStateStore,
    budget: RunBudgetTracker,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<QualityReport> {
    const projectCommands = taskUsesProjectQualityGates(taskState.task)
      ? this.loaded.config.quality.commands
      : [];
    const commands = deduplicateCommands([
      ...projectCommands,
      ...taskState.task.acceptanceCommands,
    ]);
    const quality = await runQualityCommands(
      worktree,
      commands,
      this.loaded.config.quality.commandTimeoutSeconds,
      store.artifactDirectory(
        state.id,
        taskArtifactKey(state, taskState.task.id, attempt, "quality"),
      ),
      signal,
      { maxOutputBytes: state.strategy.maxProcessOutputBytes },
    );
    await budget.recordQuality(quality);
    taskState.quality = quality;
    return quality;
  }

  private async reviewTaskAttempt(
    state: RunState,
    taskState: TaskRunState,
    worktree: string,
    store: RunStateStore,
    agent: RoleAgentService,
    quality: QualityReport,
    changedFiles: string[],
    diff: string,
    attempt: number,
  ): Promise<{ review: ReviewVerdict; test: TestVerdict }> {
    await store.transition(
      state,
      "reviewing-testing",
      `Reviewing and testing task ${taskState.task.id}, attempt ${attempt}`,
    );
    let [review, test] = await Promise.all([
      agent.runStructured({
        role: "reviewer",
        cwd: worktree,
        runId: state.id,
        artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "review"),
        context: {
          goal: state.goal,
          planSummary: state.plan!.summary,
          task: taskState.task,
          changedFiles,
          diff,
        },
        schema: reviewVerdictSchema,
        jsonSchema: reviewVerdictJsonSchema,
      }),
      agent.runStructured({
        role: "tester",
        cwd: worktree,
        runId: state.id,
        artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "test"),
        context: {
          goal: state.goal,
          task: taskState.task,
          changedFiles,
          diff,
          quality: compactQuality(quality),
        },
        schema: testVerdictSchema,
        jsonSchema: testVerdictJsonSchema,
      }),
    ]);
    if (isPlaceholderVerdict(review.value.verdict, review.value.summary) || isPlaceholderVerdict(test.value.verdict, test.value.summary)) {
      const retryKey = `${taskArtifactKey(state, taskState.task.id, attempt, "review")}-complete`;
      const [reviewRetry, testRetry] = await Promise.all([
        isPlaceholderVerdict(review.value.verdict, review.value.summary)
          ? agent.runStructured({
              role: "reviewer",
              cwd: worktree,
              runId: state.id,
              artifactKey: retryKey,
              context: {
                goal: state.goal,
                planSummary: state.plan!.summary,
                task: taskState.task,
                changedFiles,
                diff,
                previousIncompleteVerdict: review.value,
                instruction:
                  "Your previous verdict was a placeholder. Inspect the diff and return a final approve/request_changes/escalate verdict now. Do not say you are still reading.",
              },
              schema: reviewVerdictSchema,
              jsonSchema: reviewVerdictJsonSchema,
            })
          : review,
        isPlaceholderVerdict(test.value.verdict, test.value.summary)
          ? agent.runStructured({
              role: "tester",
              cwd: worktree,
              runId: state.id,
              artifactKey: `${taskArtifactKey(state, taskState.task.id, attempt, "test")}-complete`,
              context: {
                goal: state.goal,
                task: taskState.task,
                changedFiles,
                diff,
                quality: compactQuality(quality),
                previousIncompleteVerdict: test.value,
                instruction:
                  "Your previous verdict was a placeholder. Judge the acceptance commands and return a final approve/request_changes/escalate verdict now. Do not say you are still reading.",
              },
              schema: testVerdictSchema,
              jsonSchema: testVerdictJsonSchema,
            })
          : test,
      ]);
      review = reviewRetry;
      test = testRetry;
    }
    taskState.review = review.value;
    taskState.test = test.value;
    await store.save(state);
    return { review: review.value, test: test.value };
  }

  private async commitPassedTask(
    state: RunState,
    taskState: TaskRunState,
    worktree: string,
    store: RunStateStore,
    git: GitManager,
    signal?: AbortSignal,
  ): Promise<void> {
    await git.stage(worktree, signal);
    const finalFiles = await git.changedFiles(worktree, signal);
    git.assertOwnedPaths(finalFiles, taskState.task.ownedPaths);
    taskState.commit = await git.commit(
      worktree,
      `agent: ${taskState.task.id} ${taskState.task.title}`,
      signal,
    );
    taskState.status = "passed";
    await store.save(state);
  }

  /**
   * Accumulate the wall-clock time of one run/resume segment so the strategy
   * execution timeout is prorated instead of restarting on every resume.
   * Accounting must never mask the segment outcome, so failures are ignored.
   */
  private async recordExecutionSegment(
    state: RunState,
    store: RunStateStore,
    startedAt: number,
  ): Promise<void> {
    const elapsed = Date.now() - startedAt;
    if (elapsed <= 0) {
      return;
    }
    state.executionElapsedMs = (state.executionElapsedMs ?? 0) + elapsed;
    try {
      await store.save(state);
    } catch {
      // Best-effort accounting.
    }
  }

  private createRoleAgentService(
    store: RunStateStore,
    profileOverrides: Record<string, string>,
    signal: AbortSignal | undefined,
    budget: RunBudgetTracker,
    bindingsSource?: RunState | WorkflowRoleBindings,
  ): RoleAgentService {
    if (this.dependencies.createAgentService) {
      return this.dependencies.createAgentService(store, profileOverrides, signal);
    }
    return new ProfiledAgentService(
      this.configWithRuntimeProfiles(bindingsSource),
      this.loaded.root,
      store,
      profileOverrides,
      signal,
      budget,
    );
  }

  private configWithRuntimeProfiles(
    bindingsSource?: RunState | WorkflowRoleBindings,
  ): AgentTeamConfig {
    const bindings = this.roleBindingsFromSource(bindingsSource);
    if (Object.keys(bindings).length === 0) {
      return this.loaded.config;
    }
    return materializeRoleBindings(this.loaded.config, bindings).config;
  }

  private roleBindingsFromSource(
    bindingsSource?: RunState | WorkflowRoleBindings,
  ): WorkflowRoleBindings {
    if (!bindingsSource) return {};
    if (isRunState(bindingsSource)) {
      return roleBindingsFromRunState(bindingsSource);
    }
    return bindingsSource;
  }
}

function isRunState(value: RunState | WorkflowRoleBindings): value is RunState {
  return typeof value === "object" && value !== null && "id" in value && "profileOverrides" in value;
}
