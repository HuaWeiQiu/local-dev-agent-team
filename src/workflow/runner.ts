import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { RoleAgentService } from "../agents/service.js";
import { activeFlow, applyTemplateToStrategy, flowFactsFor, flowTemplate, routeTemplate, runFlow, type FlowNodeEvent, type FlowRuntime, type FlowSelection, type RunNodeKind } from "../flow/index.js";
import { goalIntakeSchema } from "../domain/contracts.js";
import { goalIntakeJsonSchema } from "../domain/json-schemas.js";
import { canUseHandoverFallback, expandPlanningGoal } from "../domain/plan.js";
import { buildRepoTree, traceRepo } from "../domain/repo-tree.js";
import { GitManager } from "../git/manager.js";
import { runQualityWithRerun } from "../quality/flaky.js";
import { RunStateStore } from "../state/store.js";
import type { RunCheckpoint, RunRoleBinding, RunState } from "../state/types.js";
import { RunArtifactCleaner } from "./cleanup.js";
import { RunExperienceRecorder } from "./experience-recorder.js";
import { branchSegment, createRunId } from "./id.js";
import { latestCheckpoint, latestApproval, recoveryArtifactKey, terminalStatusAfterFailure } from "./state-helpers.js";
import { compactQuality } from "./verdict-policy.js";
import { JevClient } from "../jev/client.js";
import { resolveStrategy } from "../strategies/resolve.js";
import { legacyExecutionTimeoutSeconds } from "../strategies/defaults.js";
import { traceIdForRun } from "../events/store.js";
import { createExecutionDeadline, RunBudgetTracker } from "../observability/budget.js";
import type { RunContext, WorkflowRunOptions, WorkflowDependencies, WorkflowResumeOptions, RunnerEnv } from "./types.js";
import { CheckpointService } from "./checkpoints.js";
import { AgentFactory } from "./agents.js";
import { TaskAttemptRunner } from "./task-attempt.js";
import { TaskScheduler } from "./scheduler.js";
import { PlanningStage } from "./planning.js";
import { scanRepoPaths } from "./repo-scan.js";
import { DecisionStage } from "./decision.js";
import { AdvisorService } from "./advisor.js";
export type {
  RunContext,
  WorkflowDependencies,
  WorkflowResumeOptions,
  WorkflowRoleBindings,
  WorkflowRunOptions,
} from "./types.js";

export {
  isHardSpecialistEscalation,
  isPlaceholderVerdict,
  shouldAcceptDocsDespiteEscalate,
  shouldTrustQualityOverReview,
} from "./verdict-policy.js";
export { terminalStatusAfterFailure } from "./state-helpers.js";

export class LocalWorkflowRunner {
  private readonly runsDirectory: string;
  private readonly worktreesDirectory: string;
  private readonly experience: RunExperienceRecorder;
  private readonly cleaner: RunArtifactCleaner;
  private readonly checkpoints: CheckpointService;
  private readonly agents: AgentFactory;
  private readonly tasks: TaskAttemptRunner;
  private readonly scheduler: TaskScheduler;
  private readonly planning: PlanningStage;
  private readonly decision: DecisionStage;
  private readonly advisor: AdvisorService;

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
    const env: RunnerEnv = {
      loaded,
      dependencies,
      runsDirectory: this.runsDirectory,
      worktreesDirectory: this.worktreesDirectory,
      forkAdvisor: dependencies.forkAdvisor ?? (jev?.enabled ? new JevClient(jev) : undefined),
      experience: this.experience,
      cleaner: this.cleaner,
    };
    this.checkpoints = new CheckpointService(env);
    this.agents = new AgentFactory(env);
    this.advisor = new AdvisorService(env);
    this.tasks = new TaskAttemptRunner(env, this.advisor);
    this.scheduler = new TaskScheduler(env, this.tasks, this.checkpoints, this.agents);
    this.planning = new PlanningStage(env, this.checkpoints);
    this.decision = new DecisionStage(env, this.checkpoints);
  }

  async run(options: WorkflowRunOptions): Promise<RunState> {
    const profileOverrides = options.profileOverrides ?? {};
    const resolvedStrategy = resolveStrategy(this.loaded.config, options.strategyName);
    const flowSelection = this.selectFlow(options);
    const strategy = applyTemplateToStrategy(resolvedStrategy, flowTemplate(flowSelection.template));
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
        flow: flowSelection,
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
      flow: flowSelection,
      ...(options.supervisorId ? { supervisorId: options.supervisorId } : {}),
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.purpose ? { purpose: options.purpose } : {}),
      tasks: [],
      history: [{ at: now, status: "created", message: "Run created" }],
    };
    await store.save(state);
    store.emit(runId, "flow.selected", flowSelection);
    const segmentStartedAt = Date.now();
    const deadline = createExecutionDeadline(strategy.executionTimeoutSeconds, options.signal);
    const workflowSignal = deadline.signal;
    const budget = new RunBudgetTracker(state, store);
    const agent = this.agents.createRoleAgentService(
      store,
      effectiveProfileOverrides,
      workflowSignal,
      budget,
      options.roleBindings,
    );

    try {
      workflowSignal.throwIfAborted();
      await git.createWorktree(integrationBranch, baseCommit, integrationWorktree);
      await this.tasks.prepareWorktreeDependencies(integrationWorktree, workflowSignal, state.strategy.maxProcessOutputBytes);
      await this.indexRepository(state, store, integrationWorktree);
      const verifiedExperiences = await this.experience.loadPlanning(options.goal, store, runId, state.repoTrace);
      const planningGoal = expandPlanningGoal(options.goal, this.loaded.root);
      const allowImpliedHandover = canUseHandoverFallback(options.goal, this.loaded.root);
      const deterministicPlan = this.planning.controllerPlan(planningGoal, allowImpliedHandover);
      await this.driveFlow({
        state,
        store,
        git,
        agent,
        budget,
        signal: workflowSignal,
        planningGoal,
        allowImpliedHandover,
        verifiedExperiences,
        ...(deterministicPlan ? { deterministicPlan } : {}),
      });
      return state;
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
    const agent = this.agents.createRoleAgentService(
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
      await this.checkpoints.assertCheckpointMatches(state, checkpoint, git);
      await this.checkpoints.reconcilePostCheckpointMerges(state, checkpoint, git, store);
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
        await this.checkpoints.prepareRecovery(state, checkpoint, store, options);
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

  private selectFlow(options: WorkflowRunOptions): FlowSelection {
    const workflow = this.loaded.config.workflow;
    return routeTemplate({
      goal: options.goal,
      ...(options.template ? { override: options.template } : {}),
      ...(workflow?.template ? { configured: workflow.template } : {}),
      evaluation: options.purpose === "evolution-evaluation",
    });
  }

  /** Runs the stage graph from `startAt`; stages park the run by returning "park". */
  private async driveFlow(context: RunContext, startAt?: RunNodeKind): Promise<void> {
    const { state, store } = context;
    const flow = activeFlow(
      state.flow ?? { template: "standard", source: "config", reasons: [], engine: "v2" },
    );
    const facts = flowFactsFor(state.strategy, {
      needsArchitect: !context.deterministicPlan,
      evaluation: state.purpose === "evolution-evaluation",
    });
    await runFlow(
      flow.run,
      {
        facts,
        handlers: this.runHandlers(context),
        ...(state.flow
          ? { onNode: (event: FlowNodeEvent) => store.emit(state.id, "flow.node", event) }
          : {}),
      },
      startAt ? { startAt } : {},
    );
  }

  private runHandlers(context: RunContext): FlowRuntime["handlers"] {
    const { state, store, git, agent, budget, signal } = context;
    return {
      intake: async () => {
        await store.transition(state, "orchestrating", "Supervising agent is analyzing the goal");
        const intake = await agent.runStructured({
          role: "orchestrator",
          runId: state.id,
          artifactKey: "intake",
          context: {
            goal: context.planningGoal,
            project: this.loaded.config.project,
            baseCommit: state.baseCommit,
            ...(context.verifiedExperiences ? { verifiedExperiences: context.verifiedExperiences } : {}),
          },
          schema: goalIntakeSchema,
          jsonSchema: goalIntakeJsonSchema,
        });
        context.intake = intake.value;
        state.intake = intake.value;
        await store.save(state);
        return "done";
      },
      explore: async () => {
        context.exploreSummary = await this.planning.maybeExplore(
          state,
          store,
          agent,
          context.planningGoal ?? state.goal,
          state.baseCommit,
          context.verifiedExperiences,
        );
        return "done";
      },
      plan: async (node) => {
        await this.planning.planStage(context, node.params?.planner === "single-task");
        return "done";
      },
      "approve-plan": async () => {
        await this.checkpoints.requestApproval(
          state,
          store,
          context.planCheckpoint ?? latestCheckpoint(state),
          "plan",
          `Approve ${state.tasks.length} planned task(s) before worker execution`,
        );
        return "park";
      },
      execute: async () => {
        await this.scheduler.executeTasks(state, store, git, agent, budget, signal);
        await this.checkpoints.recordCheckpoint(state, store, git, "tasks-complete");
        return "done";
      },
      "final-checks": async () => {
        await store.transition(state, "final-checks", "Running integration quality commands");
        await this.tasks.prepareWorktreeDependencies(
          state.integrationWorktree,
          signal,
          state.strategy.maxProcessOutputBytes,
        );
        state.finalQuality = await runQualityWithRerun(
          state.integrationWorktree,
          this.loaded.config.quality.commands,
          this.loaded.config.quality.commandTimeoutSeconds,
          store.artifactDirectory(state.id, recoveryArtifactKey(state, "final-quality")),
          signal,
          { maxOutputBytes: state.strategy.maxProcessOutputBytes },
          this.tasks.flakyReruns(),
        );
        this.tasks.noteFlaky(state, store, state.finalQuality);
        await budget.recordQuality(state.finalQuality);
        await store.save(state);
        return "done";
      },
      advise: async () => {
        // A failing integration gate already vetoes delivery, so advice would
        // only spend budget; consult the architect only when there is
        // something to ship.
        if (!state.finalQuality?.passed) return "done";
        context.preFinalAdvice = await this.advisor.consultAdvisor({
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
        });
        return "done";
      },
      decide: async (node) => {
        await this.decision.decideStage(context, node.params?.mode === "deterministic");
        return "done";
      },
      "approve-final": async () => {
        if (state.purpose === "evolution-evaluation" && context.finalCheckpoint) {
          await store.transition(
            state,
            "completed",
            "Automatic evolution evaluation completed without publication",
          );
          await this.experience.extractFromRun(state, store);
          await this.cleaner.cleanup(state, store, git);
          return "done";
        }
        const checkpoint = context.finalCheckpoint ?? latestCheckpoint(state);
        if (!context.finalCheckpoint) {
          const finalApproval = latestApproval(state, "final");
          if (finalApproval && finalApproval.checkpointId === checkpoint.id) return "done";
        }
        const blockedAfterChecks = context.finalCheckpoint
          ? state.tasks.filter((task) => task.status === "blocked")
          : [];
        await this.checkpoints.requestApproval(
          state,
          store,
          checkpoint,
          "final",
          blockedAfterChecks.length > 0
            ? `Local gates passed for merged tasks; ${blockedAfterChecks.map((task) => task.task.id).join(", ")} remain blocked`
            : "All local gates passed; approve the integration result before publication",
        );
        return "done";
      },
    };
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
    const context: RunContext = {
      state,
      store,
      git,
      agent,
      budget,
      signal,
      planCheckpoint: checkpoint,
    };
    const startAt: RunNodeKind =
      checkpoint.stage === "local-gates-passed"
        ? "approve-final"
        : checkpoint.stage === "tasks-complete"
          ? "final-checks"
          : "execute";
    await this.driveFlow(context, startAt);
    return state;
  }

  /** Freeze a path index before planning. The model receives the walked chain, not this scan. */
  private async indexRepository(state: RunState, store: RunStateStore, root: string): Promise<void> {
    const tree = buildRepoTree(scanRepoPaths(root));
    if (tree.nodes.length <= 1) return;
    state.repoTree = tree;
    state.repoTrace = traceRepo(tree, state.goal);
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

}
