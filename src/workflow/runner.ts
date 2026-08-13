import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { CommandSpec } from "../config/schema.js";
import type { RoleAgentService } from "../agents/service.js";
import { ProfiledAgentService } from "../agents/service.js";
import {
  exploreSummarySchema,
  finalDecisionSchema,
  goalIntakeSchema,
  reviewVerdictSchema,
  taskPlanSchema,
  testVerdictSchema,
  type ExploreSummary,
  type ReviewVerdict,
  type Task,
  type TestVerdict,
} from "../domain/contracts.js";
import {
  exploreSummaryJsonSchema,
  finalDecisionJsonSchema,
  goalIntakeJsonSchema,
  reviewVerdictJsonSchema,
  taskPlanJsonSchema,
  testVerdictJsonSchema,
} from "../domain/json-schemas.js";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import {
  assessPlanCompleteness,
  canUseHandoverFallback,
  classifyTaskKind,
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
  RunStatus,
  TaskRunState,
} from "../state/types.js";
import { branchSegment, createRunId } from "./id.js";
import { resolveStrategy } from "../strategies/resolve.js";
import { legacyExecutionTimeoutSeconds } from "../strategies/defaults.js";
import type { RunEventSink } from "../events/types.js";
import { traceIdForRun } from "../events/store.js";
import {
  createExecutionDeadline,
  RunBudgetExceededError,
  RunBudgetTracker,
} from "../observability/budget.js";
import { ExperienceService } from "../experience/service.js";
import {
  materializeRoleBindings,
  roleBindingsFromRunState,
} from "../desktop/role-bindings.js";
import type { AgentTeamConfig } from "../config/schema.js";

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

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly dependencies: WorkflowDependencies = {},
  ) {
    const stateRoot = path.resolve(loaded.root, loaded.config.project.stateDirectory);
    this.runsDirectory = path.join(stateRoot, "runs");
    this.worktreesDirectory = path.join(stateRoot, "worktrees");
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
      const verifiedExperiences = await this.loadPlanningExperiences(options.goal, store, runId);
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
      await store.transition(
        state,
        terminalStatusAfterFailure(error, workflowSignal),
        state.error,
      );
      await this.recordExperienceFromRun(state, store);
      await this.cleanupRunArtifacts(state, store, git);
      return state;
    } finally {
      deadline.dispose();
    }
  }

  async resume(state: RunState, options: WorkflowResumeOptions): Promise<RunState> {
    const store = new RunStateStore(this.runsDirectory, this.dependencies.eventSink);
    const git = new GitManager(this.loaded.root, this.worktreesDirectory);
    const deadline = createExecutionDeadline(
      state.strategy.executionTimeoutSeconds ?? legacyExecutionTimeoutSeconds,
      options.signal,
    );
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
      await store.transition(
        state,
        terminalStatusAfterFailure(error, workflowSignal),
        state.error,
      );
      await this.recordExperienceFromRun(state, store);
      await this.cleanupRunArtifacts(state, store, git);
      return state;
    } finally {
      deadline.dispose();
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
      },
      schema: finalDecisionSchema,
      jsonSchema: finalDecisionJsonSchema,
    });
    state.finalDecision = finalDecision.value;

    const mergedTasks = state.tasks.filter((task) => task.status === "merged");
    const blockedTasks = state.tasks.filter((task) => task.status === "blocked");
    const qualityAllowsPartial =
      state.finalQuality.passed && mergedTasks.length > 0 && blockedTasks.length > 0;
    if (!state.finalQuality.passed || (finalDecision.value.decision !== "ready" && !qualityAllowsPartial)) {
      throw new Error(
        !state.finalQuality.passed
          ? formatQualityFailure("Integration quality commands failed", state.finalQuality)
          : `Supervising agent escalated: ${finalDecision.value.reason}`,
      );
    }
    if (qualityAllowsPartial && finalDecision.value.decision !== "ready") {
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
      await this.recordExperienceFromRun(state, store);
      await this.cleanupRunArtifacts(state, store, git);
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
   * that are marked merged but absent from the checkpoint. Anything else
   * (foreign commits, missing records, divergence) keeps the refusal.
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
    if (expected.size === 0) {
      return false;
    }
    const extras = await git.commitsBetween(
      state.integrationWorktree,
      checkpoint.integrationCommit,
      "HEAD",
    );
    return (
      extras.length === expected.size && extras.every((commit) => expected.has(commit))
    );
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
      if (task.status !== "pending") {
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
    state.resumeCount = (state.resumeCount ?? 0) + 1;
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
        taskState.mergeCommit = await git.merge(
          state.integrationWorktree,
          taskState.branch,
          `merge: ${taskState.task.id} ${taskState.task.title}`,
          signal,
        );
        taskState.status = "merged";
        completed.add(taskState.task.id);
        try {
          await git.removeWorktree(taskState.worktree, signal);
        } catch (error) {
          // Worktree cleanup failure must not block an otherwise passing wave.
          await this.recordCleanupWarning(
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

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      taskState.attempts = attempt;
      taskState.status = attempt === 1 ? "working" : "reworking";
      await store.save(state);
      try {
        const reworkExperiences =
          attempt > 1 && feedback
            ? await this.loadReworkExperiences(state, store, {
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
          await this.recordAttemptCard(state, store, taskState, attempt, feedback);
          continue;
        }
        try {
          git.assertOwnedPaths(files, taskState.task.ownedPaths);
        } catch (error) {
          feedback = error instanceof Error ? error.message : String(error);
          await this.recordAttemptCard(state, store, taskState, attempt, feedback);
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
            await this.recordExperienceSuccess(state, store, lastReworkExperienceIds);
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
        await this.recordAttemptCard(state, store, taskState, attempt, feedback);
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
        await this.recordAttemptCard(state, store, taskState, attempt, feedback);
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

  private async recordCleanupWarning(
    state: RunState,
    store: RunStateStore,
    message: string,
  ): Promise<void> {
    state.history.push({ at: new Date().toISOString(), status: state.status, message });
    await store.save(state);
    store.emit(state.id, "run.cleanup-warning", { message });
  }

  /**
   * Best-effort removal of a terminal run's task worktrees and task branches
   * (including `-resume-N` variants). Failures only produce warnings. The
   * integration worktree/branch is never touched: publication and pending
   * approvals still need it.
   */
  private async cleanupRunArtifacts(
    state: RunState,
    store: RunStateStore,
    git: GitManager,
  ): Promise<void> {
    if (!["completed", "blocked", "interrupted", "cancelled"].includes(state.status)) {
      return;
    }
    const runWorktrees = path.join(this.worktreesDirectory, state.id);
    let entries: string[] = [];
    try {
      entries = await readdir(runWorktrees);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry === "integration") {
        continue;
      }
      const worktree = path.join(runWorktrees, entry);
      try {
        await git.removeWorktree(worktree);
      } catch (error) {
        await this.recordCleanupWarning(
          state,
          store,
          `Failed to remove task worktree '${worktree}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      const prefix = `agent-team/${branchSegment(state.id)}/`;
      for (const branch of await git.listBranches(`${prefix}*`)) {
        if (branch === state.integrationBranch) {
          continue;
        }
        try {
          await git.deleteBranch(branch);
        } catch (error) {
          await this.recordCleanupWarning(
            state,
            store,
            `Failed to delete task branch '${branch}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      await this.recordCleanupWarning(
        state,
        store,
        `Failed to list task branches for cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async loadPlanningExperiences(
    goal: string,
    store: RunStateStore,
    runId: string,
  ): Promise<Awaited<ReturnType<ExperienceService["retrieveForPlanning"]>>> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const bundle = await service.retrieveForPlanning(goal);
      if (bundle) {
        store.emit(runId, "experience.retrieved", {
          purpose: "planning",
          count: bundle.items.length,
          scopes: {
            shared: bundle.items.filter((item) => item.scope === "shared").length,
            project: bundle.items.filter((item) => item.scope === "project").length,
          },
        });
      }
      return bundle;
    } catch (error) {
      store.emit(runId, "experience.retrieve-failed", {
        purpose: "planning",
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async loadReworkExperiences(
    state: RunState,
    store: RunStateStore,
    input: { feedback: string; taskId: string; taskTitle: string },
  ): Promise<Awaited<ReturnType<ExperienceService["retrieveForRework"]>>> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const bundle = await service.retrieveForRework({
        feedback: input.feedback,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        limit: 5,
      });
      if (bundle) {
        store.emit(state.id, "experience.retrieved", {
          purpose: "rework",
          taskId: input.taskId,
          count: bundle.items.length,
        });
      }
      return bundle;
    } catch (error) {
      store.emit(state.id, "experience.retrieve-failed", {
        purpose: "rework",
        taskId: input.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async recordExperienceFromRun(
    state: RunState,
    store: RunStateStore,
  ): Promise<void> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const { created, autoPromoted } = await service.extractFromRun(state);
      if (created.length > 0) {
        store.emit(state.id, "experience.extracted", {
          count: created.length,
          ids: created.map((entry) => entry.id),
          autoPromoted: autoPromoted.map((entry) => entry.id),
        });
      }
    } catch (error) {
      store.emit(state.id, "experience.extract-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
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

  private async recordAttemptCard(
    state: RunState,
    store: RunStateStore,
    taskState: TaskRunState,
    attempt: number,
    feedback: string,
  ): Promise<void> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const card = await service.recordAttempt({
        runId: state.id,
        taskId: taskState.task.id,
        taskTitle: taskState.task.title,
        attempt,
        feedback,
      });
      if (card) {
        store.emit(state.id, "experience.attempt-recorded", {
          taskId: card.taskId,
          attempt: card.attempt,
          signature: card.signature,
        });
      }
    } catch (error) {
      store.emit(state.id, "experience.attempt-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordExperienceSuccess(
    state: RunState,
    store: RunStateStore,
    experienceIds: string[],
  ): Promise<void> {
    try {
      const service = ExperienceService.forLoaded(this.loaded);
      const updated = await service.recordSuccess(experienceIds);
      if (updated > 0) {
        store.emit(state.id, "experience.success-recorded", {
          count: updated,
          ids: experienceIds,
        });
      }
    } catch (error) {
      store.emit(state.id, "experience.success-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function latestCheckpoint(state: RunState): RunCheckpoint {
  const checkpoint = state.checkpoints?.at(-1);
  if (!checkpoint) {
    throw new Error(`Run '${state.id}' has no durable checkpoint`);
  }
  return checkpoint;
}

function truncateExploreSummary(summary: ExploreSummary, maxChars: number): ExploreSummary {
  if (maxChars <= 0) {
    return {
      summary: summary.summary.slice(0, 200),
      modules: [],
      riskPaths: [],
      suggestedAcceptanceCommands: [],
      forbiddenPaths: [],
      notes: [],
    };
  }
  const clone: ExploreSummary = {
    summary: summary.summary,
    modules: [...summary.modules],
    riskPaths: [...summary.riskPaths],
    suggestedAcceptanceCommands: [...summary.suggestedAcceptanceCommands],
    forbiddenPaths: [...summary.forbiddenPaths],
    notes: [...summary.notes],
  };
  const encoded = () => JSON.stringify(clone);
  if (encoded().length <= maxChars) {
    return clone;
  }
  // Shrink arrays first, then summary text.
  while (encoded().length > maxChars) {
    if (clone.notes.length > 0) {
      clone.notes.pop();
      continue;
    }
    if (clone.suggestedAcceptanceCommands.length > 0) {
      clone.suggestedAcceptanceCommands.pop();
      continue;
    }
    if (clone.modules.length > 0) {
      clone.modules.pop();
      continue;
    }
    if (clone.riskPaths.length > 0) {
      clone.riskPaths.pop();
      continue;
    }
    if (clone.forbiddenPaths.length > 0) {
      clone.forbiddenPaths.pop();
      continue;
    }
    const budget = Math.max(80, maxChars - 40);
    clone.summary = `${clone.summary.slice(0, budget)}…`;
    break;
  }
  return clone;
}

function latestApproval(
  state: RunState,
  gate: ApprovalRequest["gate"],
): ApprovalRequest | undefined {
  for (let index = (state.approvals?.length ?? 0) - 1; index >= 0; index -= 1) {
    const approval = state.approvals?.[index];
    if (approval?.gate === gate) return approval;
  }
  return undefined;
}

/**
 * A plan needs human approval only when the strategy gates "plan".
 * Project quality.commands remain the real gate; agent-authored
 * acceptanceCommands must not force an extra plan stop.
 */
function requiresPlanApproval(state: RunState): boolean {
  return state.strategy.approvalGates.includes("plan");
}

function resetIncompleteTask(task: TaskRunState): void {  task.status = "pending";
  task.attempts = 0;
  delete task.branch;
  delete task.worktree;
  delete task.commit;
  delete task.mergeCommit;
  delete task.profile;
  delete task.quality;
  delete task.review;
  delete task.test;
  delete task.error;
}

function recoveryArtifactKey(state: RunState, key: string): string {
  return state.resumeCount ? `recoveries/${state.resumeCount}/${key}` : key;
}

function taskArtifactKey(
  state: RunState,
  taskId: string,
  attempt: number,
  artifact: string,
): string {
  return recoveryArtifactKey(state, `tasks/${taskId}/attempt-${attempt}/${artifact}`);
}

function findTaskState(state: RunState, taskId: string): TaskRunState {
  const task = state.tasks.find((item) => item.task.id === taskId);
  if (!task) {
    throw new Error(`Missing state for task '${taskId}'`);
  }
  return task;
}

export function isPlaceholderVerdict(verdict: string, summary: string): boolean {
  const text = `${verdict} ${summary}`.toLowerCase();
  return (
    /review in progress|placeholder will be replaced|still reading|before issuing|before judging|reading the full (review|tester) prompt|independently inspecting|inspecting .+ before issuing|正在检查|再给结论|正在阅读|正在读|先读完|尚未给出/.test(
      text,
    )
  );
}

export function shouldAcceptDocsDespiteEscalate(
  task: Task,
  review: ReviewVerdict,
  test: TestVerdict,
): boolean {
  const kind = classifyTaskKind(task);
  if (kind !== "docs" && kind !== "host-evidence") {
    return false;
  }
  return isHardSpecialistEscalation(review, test) || shouldTrustQualityOverReview(review, test);
}

export function isHardSpecialistEscalation(review: ReviewVerdict, test: TestVerdict): boolean {
  const reviewEscalated = review.verdict === "escalate" && !isPlaceholderVerdict(review.verdict, review.summary);
  const testEscalated = test.verdict === "escalate" && !isPlaceholderVerdict(test.verdict, test.summary);
  return reviewEscalated || testEscalated;
}

export function shouldTrustQualityOverReview(review: ReviewVerdict, test: TestVerdict): boolean {
  const reviewOk =
    review.verdict === "approve"
    || isPlaceholderVerdict(review.verdict, review.summary);
  const testOk =
    test.verdict === "approve"
    || isPlaceholderVerdict(test.verdict, test.summary);
  return reviewOk && testOk;
}

function passesTaskGates(
  quality: QualityReport,
  review: ReviewVerdict,
  test: TestVerdict,
): boolean {
  return (
    quality.passed &&
    review.verdict === "approve" &&
    !review.findings.some((finding) => finding.required) &&
    test.verdict === "approve"
  );
}

function buildReworkFeedback(
  quality: QualityReport,
  review: ReviewVerdict,
  test: TestVerdict,
): string {
  return JSON.stringify(
    {
      deterministicChecks: compactQuality(quality),
      review,
      test,
    },
    null,
    2,
  );
}

function isRunState(value: RunState | WorkflowRoleBindings): value is RunState {
  return typeof value === "object" && value !== null && "id" in value && "profileOverrides" in value;
}

function compactQuality(report: QualityReport): unknown {
  return {
    passed: report.passed,
    commands: report.commands.map((command) => ({
      command: command.spec,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
      stdout: command.stdout.slice(-20_000),
      stderr: command.stderr.slice(-20_000),
    })),
  };
}

/**
 * Map workflow failure to a terminal status.
 * Explicit user cancel → cancelled; control-plane shutdown / other aborts → interrupted
 * so the UI can offer checkpoint resume instead of a full restart.
 */
export function terminalStatusAfterFailure(
  error: unknown,
  signal?: AbortSignal,
): Extract<RunStatus, "cancelled" | "interrupted" | "blocked"> {
  if (!signal?.aborted) return "blocked";
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled by user/i.test(message) || /^Run cancelled\b/i.test(message)) {
    return "cancelled";
  }
  return "interrupted";
}
