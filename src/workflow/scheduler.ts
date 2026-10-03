import path from "node:path";
import type { RoleAgentService } from "../agents/service.js";
import { selectTaskWave } from "../domain/plan.js";
import { type GitManager } from "../git/manager.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { branchSegment } from "./id.js";
import { latestCheckpoint, findTaskState } from "./state-helpers.js";
import { type RunBudgetTracker } from "../observability/budget.js";
import type { RunnerEnv } from "./types.js";
import type { TaskAttemptRunner } from "./task-attempt.js";
import type { CheckpointService } from "./checkpoints.js";
import type { AgentFactory } from "./agents.js";

export class TaskScheduler {
  constructor(
    private readonly env: RunnerEnv,
    private readonly tasks: TaskAttemptRunner,
    private readonly checkpoints: CheckpointService,
    private readonly agents: AgentFactory,
  ) {}

  async executeTasks(
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
          await this.env.cleaner.warn(
            state,
            store,
            `Failed to remove task worktree '${taskState.worktree}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        await store.save(state);
      }
      await this.checkpoints.recordCheckpoint(state, store, git, "task-wave-integrated");
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
      const waveAgent = this.env.dependencies.createAgentService
        ? this.env.dependencies.createAgentService(store, waveProfileOverrides, waveSignal)
        : this.agents.profiledAgent(this.env.loaded.config, store, waveProfileOverrides, waveSignal, budget);
      const results = await Promise.allSettled(
        wave.map(async (task) => {
          const taskState = findTaskState(state, task.id);
          const reuseWorktree = await this.tasks.canReusePassedWorktree(taskState);
          if (!reuseWorktree) {
            const recoverySuffix = state.resumeCount ? `-resume-${state.resumeCount}` : "";
            const taskSegment = `${branchSegment(task.id)}${recoverySuffix}`;
            const branch = `agent-team/${branchSegment(state.id)}/${taskSegment}`;
            const worktree = path.join(this.env.worktreesDirectory, state.id, taskSegment);
            taskState.branch = branch;
            taskState.worktree = worktree;
            taskState.status = "working";
            await git.createWorktree(branch, integrationCommit, worktree, waveSignal);
            await this.tasks.prepareWorktreeDependencies(
              worktree,
              waveSignal,
              state.strategy.maxProcessOutputBytes,
            );
            await store.save(state);
          }
          await this.tasks.executeOneTask(state, taskState, store, git, waveAgent, budget, waveSignal);
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
          await this.env.cleaner.warn(
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
      await this.checkpoints.recordCheckpoint(state, store, git, "task-wave-integrated");
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
}
