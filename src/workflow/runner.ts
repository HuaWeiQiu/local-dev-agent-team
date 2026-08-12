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
import { mkdir, writeFile } from "node:fs/promises";
import { selectTaskWave, validateTaskPlan } from "../domain/plan.js";
import { GitManager } from "../git/manager.js";
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
  RunBudgetTracker,
} from "../observability/budget.js";
import { ExperienceService } from "../experience/service.js";

export interface WorkflowRunOptions {
  goal: string;
  profileOverrides?: Record<string, string>;
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

    await git.assertReady();
    const baseCommit = await git.resolveCommit(this.loaded.config.project.defaultBranch);
    const integrationBranch = `agent-team/${branchSegment(runId)}/integration`;
    const integrationWorktree = path.join(this.worktreesDirectory, runId, "integration");
    const now = new Date().toISOString();
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
    const agent = this.dependencies.createAgentService
      ? this.dependencies.createAgentService(store, effectiveProfileOverrides, workflowSignal)
      : new ProfiledAgentService(
          this.loaded.config,
          this.loaded.root,
          store,
          effectiveProfileOverrides,
          workflowSignal,
          budget,
        );

    try {
      workflowSignal.throwIfAborted();
      await git.createWorktree(integrationBranch, baseCommit, integrationWorktree);
      const verifiedExperiences = await this.loadPlanningExperiences(options.goal, store, runId);
      await store.transition(state, "orchestrating", "Supervising agent is analyzing the goal");
      const intake = await agent.runStructured({
        role: "orchestrator",
        runId,
        artifactKey: "intake",
        context: {
          goal: options.goal,
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
        options.goal,
        baseCommit,
        verifiedExperiences,
      );

      await store.transition(state, "architecting", "架构正在拆分任务 DAG（plan）");
      const workerRole = this.loaded.config.roles.worker;
      if (!workerRole) {
        throw new Error("Required worker role is missing");
      }
      const architecture = await agent.runStructured({
        role: "architect",
        runId,
        artifactKey: "architecture",
        context: {
          goal: options.goal,
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
      state.plan = architecture.value;
      state.tasks = architecture.value.tasks.map((task) => ({
        task,
        status: "pending",
        attempts: 0,
      }));
      await store.transition(state, "planned", `Architect produced ${state.tasks.length} task(s)`);
      const checkpoint = await this.recordCheckpoint(state, store, git, "plan-ready");
      if (
        state.strategy.approvalGates.includes("plan") &&
        state.purpose !== "evolution-evaluation"
      ) {
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
        terminalStatusAfterFailure(error, options.signal),
        state.error,
      );
      await this.recordExperienceFromRun(state, store);
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
    const agent = this.dependencies.createAgentService
      ? this.dependencies.createAgentService(store, effectiveProfileOverrides, workflowSignal)
      : new ProfiledAgentService(
          this.loaded.config,
          this.loaded.root,
          store,
          effectiveProfileOverrides,
          workflowSignal,
          budget,
        );
    try {
      workflowSignal.throwIfAborted();
      await git.assertReady();
      if (state.root !== this.loaded.root || state.configPath !== this.loaded.path) {
        throw new Error("Run checkpoint belongs to a different project configuration");
      }
      const checkpoint = latestCheckpoint(state);
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
        terminalStatusAfterFailure(error, options.signal),
        state.error,
      );
      await this.recordExperienceFromRun(state, store);
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

    if (!state.finalQuality.passed || finalDecision.value.decision !== "ready") {
      throw new Error(
        !state.finalQuality.passed
          ? "Integration quality commands failed"
          : `Supervising agent escalated: ${finalDecision.value.reason}`,
      );
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
      return state;
    }
    await this.requestApproval(
      state,
      store,
      finalCheckpoint,
      "final",
      "All local gates passed; approve the integration result before publication",
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
      throw new Error(
        `Integration worktree HEAD '${integrationCommit}' does not match checkpoint '${checkpoint.integrationCommit}'`,
      );
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
      state.strategy.approvalGates.includes("plan")
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
    const started = new Set(checkpoint.completedTaskIds);

    while (completed.size < state.plan.tasks.length) {
      signal?.throwIfAborted();
      const concurrency = state.strategy.swarmMaxConcurrency ?? state.strategy.maxParallel;
      const wave = selectTaskWave(
        state.plan,
        completed,
        started,
        concurrency,
      );
      if (wave.length === 0) {
        throw new Error("No dependency-ready tasks remain");
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

      const integrationCommit = await git.currentCommit(state.integrationWorktree);
      const taskStates = await Promise.all(
        wave.map(async (task) => {
          const taskState = findTaskState(state, task.id);
          const recoverySuffix = state.resumeCount ? `-resume-${state.resumeCount}` : "";
          const taskSegment = `${branchSegment(task.id)}${recoverySuffix}`;
          const branch = `agent-team/${branchSegment(state.id)}/${taskSegment}`;
          const worktree = path.join(this.worktreesDirectory, state.id, taskSegment);
          taskState.branch = branch;
          taskState.worktree = worktree;
          taskState.status = "working";
          await git.createWorktree(branch, integrationCommit, worktree);
          await store.save(state);
          await this.executeOneTask(state, taskState, store, git, agent, budget, signal);
          return taskState;
        }),
      );

      const blocked = taskStates.find((task) => task.status === "blocked");
      if (blocked) {
        store.emit(state.id, "run.wave.completed", {
          taskIds: waveTaskIds,
          concurrency: wave.length,
          status: "blocked",
          blockedTaskId: blocked.task.id,
        });
        throw new Error(`Task '${blocked.task.id}' blocked: ${blocked.error ?? "unknown error"}`);
      }

      await store.transition(state, "integrating", "合并本波次通过的任务");
      for (const taskState of taskStates.sort((left, right) => left.task.id.localeCompare(right.task.id))) {
        if (!taskState.branch || !taskState.worktree) {
          throw new Error(`Task '${taskState.task.id}' has no branch/worktree metadata`);
        }
        await git.merge(
          state.integrationWorktree,
          taskState.branch,
          `merge: ${taskState.task.id} ${taskState.task.title}`,
        );
        taskState.status = "merged";
        completed.add(taskState.task.id);
        await git.removeWorktree(taskState.worktree);
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

        await git.stage(taskState.worktree);
        const files = await git.changedFiles(taskState.worktree);
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
        const diff = await git.stagedDiff(taskState.worktree);
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

        if (review.verdict === "escalate" || test.verdict === "escalate") {
          throw new Error(
            `Specialist escalated task: ${review.summary}; ${test.summary}`,
          );
        }
        if (passesTaskGates(quality, review, test)) {
          if (attempt > 1 && lastReworkExperienceIds.length > 0) {
            await this.recordExperienceSuccess(state, store, lastReworkExperienceIds);
          }
          await this.commitPassedTask(state, taskState, taskState.worktree, store, git);
          return;
        }
        feedback = buildReworkFeedback(quality, review, test);
        await this.recordAttemptCard(state, store, taskState, attempt, feedback);
        await store.transition(
          state,
          "reworking",
          `Task ${taskState.task.id} failed gates on attempt ${attempt}`,
        );
      } catch (error) {
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

  private async runTaskQualityGates(
    state: RunState,
    taskState: TaskRunState,
    worktree: string,
    store: RunStateStore,
    budget: RunBudgetTracker,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<QualityReport> {
    const commands = deduplicateCommands([
      ...this.loaded.config.quality.commands,
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
    const [review, test] = await Promise.all([
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
  ): Promise<void> {
    await git.stage(worktree);
    const finalFiles = await git.changedFiles(worktree);
    git.assertOwnedPaths(finalFiles, taskState.task.ownedPaths);
    taskState.commit = await git.commit(
      worktree,
      `agent: ${taskState.task.id} ${taskState.task.title}`,
    );
    taskState.status = "passed";
    await store.save(state);
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

function resetIncompleteTask(task: TaskRunState): void {
  task.status = "pending";
  task.attempts = 0;
  delete task.branch;
  delete task.worktree;
  delete task.commit;
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
