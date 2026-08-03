import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { CommandSpec } from "../config/schema.js";
import type { RoleAgentService } from "../agents/service.js";
import { ProfiledAgentService } from "../agents/service.js";
import {
  finalDecisionSchema,
  goalIntakeSchema,
  reviewVerdictSchema,
  taskPlanSchema,
  testVerdictSchema,
  type ReviewVerdict,
  type Task,
  type TestVerdict,
} from "../domain/contracts.js";
import {
  finalDecisionJsonSchema,
  goalIntakeJsonSchema,
  reviewVerdictJsonSchema,
  taskPlanJsonSchema,
  testVerdictJsonSchema,
} from "../domain/json-schemas.js";
import { selectTaskWave, validateTaskPlan } from "../domain/plan.js";
import { GitManager } from "../git/manager.js";
import {
  deduplicateCommands,
  runQualityCommands,
  type QualityReport,
} from "../quality/run.js";
import { RunStateStore } from "../state/store.js";
import type { RunState, TaskRunState } from "../state/types.js";
import { branchSegment, createRunId } from "./id.js";

export interface WorkflowRunOptions {
  goal: string;
  profileOverrides?: Record<string, string>;
}

export interface WorkflowDependencies {
  createAgentService?: (
    store: RunStateStore,
    profileOverrides: Record<string, string>,
  ) => RoleAgentService;
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
    const runId = createRunId(options.goal);
    const store = new RunStateStore(this.runsDirectory);
    const git = new GitManager(this.loaded.root, this.worktreesDirectory);
    const agent = this.dependencies.createAgentService
      ? this.dependencies.createAgentService(store, profileOverrides)
      : new ProfiledAgentService(
          this.loaded.config,
          this.loaded.root,
          store,
          profileOverrides,
        );

    await git.assertReady();
    const baseCommit = await git.resolveCommit(this.loaded.config.project.defaultBranch);
    const integrationBranch = `agent-team/${branchSegment(runId)}/integration`;
    const integrationWorktree = path.join(this.worktreesDirectory, runId, "integration");
    const now = new Date().toISOString();
    const state: RunState = {
      id: runId,
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
      tasks: [],
      history: [{ at: now, status: "created", message: "Run created" }],
    };
    await store.save(state);

    try {
      await git.createWorktree(integrationBranch, baseCommit, integrationWorktree);
      await store.transition(state, "orchestrating", "Supervising agent is analyzing the goal");
      const intake = await agent.runStructured({
        role: "orchestrator",
        runId,
        artifactKey: "intake",
        context: {
          goal: options.goal,
          project: this.loaded.config.project,
          baseCommit,
        },
        schema: goalIntakeSchema,
        jsonSchema: goalIntakeJsonSchema,
      });
      state.intake = intake.value;
      await store.save(state);

      await store.transition(state, "architecting", "Architect is producing a task DAG");
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

      await this.executeTasks(state, store, git, agent);

      await store.transition(state, "final-checks", "Running integration quality commands");
      state.finalQuality = await runQualityCommands(
        state.integrationWorktree,
        this.loaded.config.quality.commands,
        this.loaded.config.quality.commandTimeoutSeconds,
        store.artifactDirectory(runId, "final-quality"),
      );
      await store.save(state);

      const finalDecision = await agent.runStructured({
        role: "orchestrator",
        promptKey: "orchestrator-final",
        cwd: state.integrationWorktree,
        runId,
        artifactKey: "final-decision",
        context: {
          goal: state.goal,
          planSummary: state.plan.summary,
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
      await store.transition(
        state,
        "awaiting-human",
        "All local gates passed; awaiting optional publication and human merge",
      );
      return state;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      await store.transition(state, "blocked", state.error);
      return state;
    }
  }

  private async executeTasks(
    state: RunState,
    store: RunStateStore,
    git: GitManager,
    agent: RoleAgentService,
  ): Promise<void> {
    if (!state.plan) {
      throw new Error("Cannot execute tasks without a plan");
    }
    const completed = new Set<string>();
    const started = new Set<string>();

    while (completed.size < state.plan.tasks.length) {
      const wave = selectTaskWave(
        state.plan,
        completed,
        started,
        this.loaded.config.project.maxParallel,
      );
      if (wave.length === 0) {
        throw new Error("No dependency-ready tasks remain");
      }
      for (const task of wave) {
        started.add(task.id);
      }
      await store.transition(
        state,
        "implementing",
        `Starting worker wave: ${wave.map((task) => task.id).join(", ")}`,
      );

      const integrationCommit = await git.currentCommit(state.integrationWorktree);
      const taskStates = await Promise.all(
        wave.map(async (task) => {
          const taskState = findTaskState(state, task.id);
          const branch = `agent-team/${branchSegment(state.id)}/${branchSegment(task.id)}`;
          const worktree = path.join(this.worktreesDirectory, state.id, branchSegment(task.id));
          taskState.branch = branch;
          taskState.worktree = worktree;
          taskState.status = "working";
          await git.createWorktree(branch, integrationCommit, worktree);
          await store.save(state);
          await this.executeOneTask(state, taskState, store, git, agent);
          return taskState;
        }),
      );

      const blocked = taskStates.find((task) => task.status === "blocked");
      if (blocked) {
        throw new Error(`Task '${blocked.task.id}' blocked: ${blocked.error ?? "unknown error"}`);
      }

      await store.transition(state, "integrating", "Merging the passing worker wave");
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
    }
  }

  private async executeOneTask(
    state: RunState,
    taskState: TaskRunState,
    store: RunStateStore,
    git: GitManager,
    agent: RoleAgentService,
  ): Promise<void> {
    if (!taskState.worktree || !state.plan) {
      throw new Error(`Task '${taskState.task.id}' worktree is not initialized`);
    }
    const maxAttempts = this.loaded.config.quality.maxReworkAttempts + 1;
    let feedback = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      taskState.attempts = attempt;
      taskState.status = attempt === 1 ? "working" : "reworking";
      await store.save(state);
      try {
        const worker = await agent.runText({
          role: "worker",
          cwd: taskState.worktree,
          runId: state.id,
          artifactKey: `tasks/${taskState.task.id}/attempt-${attempt}/worker`,
          ...(taskState.task.profile ? { profileName: taskState.task.profile } : {}),
          context: {
            goal: state.goal,
            planSummary: state.plan.summary,
            task: taskState.task,
            attempt,
            feedback,
          },
        });
        taskState.profile = worker.profileName;

        const commands = deduplicateCommands([
          ...this.loaded.config.quality.commands,
          ...taskState.task.acceptanceCommands,
        ]);
        const quality = await runQualityCommands(
          taskState.worktree,
          commands,
          this.loaded.config.quality.commandTimeoutSeconds,
          store.artifactDirectory(
            state.id,
            `tasks/${taskState.task.id}/attempt-${attempt}/quality`,
          ),
        );
        taskState.quality = quality;

        await git.stage(taskState.worktree);
        const files = await git.changedFiles(taskState.worktree);
        if (files.length === 0) {
          feedback = "No repository changes were produced. Implement the assigned task.";
          continue;
        }
        try {
          git.assertOwnedPaths(files, taskState.task.ownedPaths);
        } catch (error) {
          feedback = error instanceof Error ? error.message : String(error);
          continue;
        }
        const diff = await git.stagedDiff(taskState.worktree);
        await store.transition(
          state,
          "reviewing-testing",
          `Reviewing and testing task ${taskState.task.id}, attempt ${attempt}`,
        );
        const [review, test] = await Promise.all([
          agent.runStructured({
            role: "reviewer",
            cwd: taskState.worktree,
            runId: state.id,
            artifactKey: `tasks/${taskState.task.id}/attempt-${attempt}/review`,
            context: {
              goal: state.goal,
              planSummary: state.plan.summary,
              task: taskState.task,
              changedFiles: files,
              diff,
            },
            schema: reviewVerdictSchema,
            jsonSchema: reviewVerdictJsonSchema,
          }),
          agent.runStructured({
            role: "tester",
            cwd: taskState.worktree,
            runId: state.id,
            artifactKey: `tasks/${taskState.task.id}/attempt-${attempt}/test`,
            context: {
              goal: state.goal,
              task: taskState.task,
              changedFiles: files,
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

        if (review.value.verdict === "escalate" || test.value.verdict === "escalate") {
          throw new Error(
            `Specialist escalated task: ${review.value.summary}; ${test.value.summary}`,
          );
        }
        if (passesTaskGates(quality, review.value, test.value)) {
          await git.stage(taskState.worktree);
          const finalFiles = await git.changedFiles(taskState.worktree);
          git.assertOwnedPaths(finalFiles, taskState.task.ownedPaths);
          taskState.commit = await git.commit(
            taskState.worktree,
            `agent: ${taskState.task.id} ${taskState.task.title}`,
          );
          taskState.status = "passed";
          await store.save(state);
          return;
        }
        feedback = buildReworkFeedback(quality, review.value, test.value);
        await store.transition(
          state,
          "reworking",
          `Task ${taskState.task.id} failed gates on attempt ${attempt}`,
        );
      } catch (error) {
        feedback = error instanceof Error ? error.message : String(error);
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
