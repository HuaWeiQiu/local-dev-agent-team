import path from "node:path";
import type { RoleAgentService } from "../agents/service.js";
import { selectTaskWave } from "../domain/plan.js";
import { type GitManager } from "../git/manager.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState, TaskRunState } from "../state/types.js";
import { branchSegment } from "./id.js";
import { latestCheckpoint, findTaskState } from "./state-helpers.js";
import { type RunBudgetTracker } from "../observability/budget.js";
import type { RunnerEnv } from "./types.js";
import type { TaskAttemptRunner } from "./task-attempt.js";
import type { CheckpointService } from "./checkpoints.js";
import type { AgentFactory } from "./agents.js";
import { assertCapability } from "../runtime/roles.js";

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
    assertCapability("worker", "execute");
    if (!state.plan) {
      throw new Error("Cannot execute tasks without a plan");
    }
    const completed = completedTaskIds(state);
    const blockedIds = blockedTaskIds(state);
    await this.mergeInterruptedPasses(state, store, git, completed, signal);
    const started = new Set([...completed, ...blockedIds]);

    while (completed.size + blockedIds.size < state.plan.tasks.length) {
      signal?.throwIfAborted();
      const planned = plannedWave(state, completed, started);
      if (planned === undefined) break;
      if (planned.length === 0) {
        await this.blockRemaining(state, store, completed, blockedIds);
        break;
      }
      await this.runWave({ state, store, git, agent, budget, signal, wave: planned, completed, blockedIds, started });
    }
    await this.settleBlocked(state, store);
  }

  /**
   * Tasks that passed quality but were not merged before the interruption are
   * merged first, so the wave loop starts from a settled integration branch.
   */
  private async mergeInterruptedPasses(
    state: RunState,
    store: RunStateStore,
    git: GitManager,
    completed: Set<string>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const passed = state.tasks.filter(
      (task) =>
        task.status === "passed"
        && !completed.has(task.task.id)
        && Boolean(task.branch)
        && Boolean(task.worktree)
        && Boolean(task.commit),
    );
    if (passed.length === 0) return;
    await store.transition(state, "integrating", "合并中断前已通过质量门的任务");
    for (const taskState of [...passed].sort(byTaskId)) {
      await this.mergeOne(state, store, git, taskState, completed, signal);
    }
    await this.checkpoints.recordCheckpoint(state, store, git, "task-wave-integrated");
  }

  /** One wave: start its tasks, collect what happened, integrate what passed. */
  private async runWave(input: {
    state: RunState;
    store: RunStateStore;
    git: GitManager;
    agent: RoleAgentService;
    budget: RunBudgetTracker;
    signal: AbortSignal | undefined;
    wave: ReturnType<typeof selectTaskWave>;
    completed: Set<string>;
    blockedIds: Set<string>;
    started: Set<string>;
  }): Promise<void> {
    const { state, store, git, signal, wave } = input;
    for (const task of wave) input.started.add(task.id);
    const waveTaskIds = wave.map((task) => task.id);
    const batchKeys = waveBatchKeys(wave);
    const concurrency = state.strategy.swarmMaxConcurrency ?? state.strategy.maxParallel;
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
    const results = await Promise.allSettled(
      wave.map(async (task) => await this.runWaveTask(input, task, integrationCommit)),
    );
    const taskStates = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const passedStates = taskStates.filter((task) => task.status === "passed");
    const blocked = taskStates.filter((task) => task.status === "blocked");

    this.reportWaveOutcome(input, { wave, waveTaskIds, batchKeys, rejection, passedStates, blocked });

    await store.transition(state, "integrating", "合并本波次通过的任务");
    for (const taskState of [...passedStates].sort(byTaskId)) {
      await this.mergeOne(state, store, git, taskState, input.completed, signal);
    }
    store.emit(state.id, "run.wave.completed", {
      taskIds: waveTaskIds,
      concurrency: wave.length,
      status: "merged",
      batchKeys,
    });
    await this.checkpoints.recordCheckpoint(state, store, git, "task-wave-integrated");
  }

  /**
   * Say how the wave ended and what it leaves blocked. A wave where every task
   * failed is the one case that stops the run: nothing was integrated, so there is
   * nothing to build on.
   */
  private reportWaveOutcome(
    input: { state: RunState; store: RunStateStore; blockedIds: Set<string> },
    outcome: {
      wave: ReadonlyArray<unknown>;
      waveTaskIds: string[];
      batchKeys: string[];
      rejection: PromiseRejectedResult | undefined;
      passedStates: ReadonlyArray<unknown>;
      blocked: ReadonlyArray<{ task: { id: string } }>;
    },
  ): void {
    const { state, store } = input;
    const { rejection, passedStates, blocked } = outcome;
    store.emit(state.id, "run.wave.completed", {
      taskIds: outcome.waveTaskIds,
      concurrency: outcome.wave.length,
      status: waveStatus(rejection, passedStates.length, blocked.length),
      ...(rejection ? { error: messageOf(rejection.reason) } : {}),
      ...(blocked[0] ? { blockedTaskId: blocked[0].task.id } : {}),
      batchKeys: outcome.batchKeys,
    });
    if (rejection && passedStates.length === 0 && blocked.length === 0) throw rejection.reason;
    for (const task of blocked) input.blockedIds.add(task.task.id);
  }

  /** One task of a wave: give it a worktree if it needs one, then run it. */
  private async runWaveTask(
    input: {
      state: RunState;
      store: RunStateStore;
      git: GitManager;
      agent: RoleAgentService;
      budget: RunBudgetTracker;
      signal: AbortSignal | undefined;
    },
    task: ReturnType<typeof selectTaskWave>[number],
    integrationCommit: string,
  ): Promise<TaskRunState> {
    const { state, store, git, signal } = input;
    const taskState = findTaskState(state, task.id);
    const waveAgent = this.waveAgent(input, task);
    const reuseWorktree = await this.tasks.canReusePassedWorktree(taskState);
    if (!reuseWorktree) {
      const recoverySuffix = state.resumeCount ? `-resume-${state.resumeCount}` : "";
      const taskSegment = `${branchSegment(task.id)}${recoverySuffix}`;
      const branch = `agent-team/${branchSegment(state.id)}/${taskSegment}`;
      const worktree = path.join(this.env.worktreesDirectory, state.id, taskSegment);
      taskState.branch = branch;
      taskState.worktree = worktree;
      taskState.status = "working";
      await git.createWorktree(branch, integrationCommit, worktree, signal);
      await this.tasks.prepareWorktreeDependencies(worktree, signal, state.strategy.maxProcessOutputBytes);
      await store.save(state);
    }
    await this.tasks.executeOneTask(state, taskState, store, git, waveAgent, input.budget, signal);
    return taskState;
  }

  /** The agent a wave's tasks share: the caller's factory, or the profiled default. */
  private waveAgent(
    input: {
      state: RunState;
      store: RunStateStore;
      signal: AbortSignal | undefined;
      agent: RoleAgentService;
      budget: RunBudgetTracker;
    },
    task: ReturnType<typeof selectTaskWave>[number],
  ): RoleAgentService {
    void task;
    const { state, store, signal } = input;
    const waveProfileOverrides = { ...state.strategy.roleProfiles, ...state.profileOverrides };
    return this.env.dependencies.createAgentService
      ? this.env.dependencies.createAgentService(store, waveProfileOverrides, signal)
      : this.agents.profiledAgent(this.env.loaded.config, store, waveProfileOverrides, signal, input.budget);
  }

  /** Merge one passed task, recording the intent before the git side effect. */
  private async mergeOne(
    state: RunState,
    store: RunStateStore,
    git: GitManager,
    taskState: RunState["tasks"][number],
    completed: Set<string>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!taskState.branch || !taskState.worktree) {
      throw new Error(`Task '${taskState.task.id}' has no branch/worktree metadata`);
    }
    // A crash after the merge but before the next save is then recoverable by
    // matching the deterministic merge-commit subject during resume.
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
    await this.removeMergedWorktree(state, store, git, taskState.worktree, signal);
    await store.save(state);
  }

  /** Cleanup is best effort: a leftover worktree must not fail an integrated wave. */
  private async removeMergedWorktree(
    state: RunState,
    store: RunStateStore,
    git: GitManager,
    worktree: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await git.removeWorktree(worktree, signal);
    } catch (error) {
      await this.env.cleaner.warn(
        state,
        store,
        `Failed to remove task worktree '${worktree}': ${messageOf(error)}`,
      );
    }
  }

  /** Nothing left to schedule: whatever is unfinished is blocked behind a failure. */
  private async blockRemaining(
    state: RunState,
    store: RunStateStore,
    completed: Set<string>,
    blockedIds: Set<string>,
  ): Promise<void> {
    markUnfinishedBlocked(state, completed, blockedIds);
    await store.save(state);
  }

  /** Report what a partly blocked run leaves behind. */
  private async settleBlocked(state: RunState, store: RunStateStore): Promise<void> {
    const leftoverBlocked = state.tasks.filter((task) => task.status === "blocked");
    if (leftoverBlocked.length === 0) return;
    const merged = state.tasks.filter((task) => task.status === "merged");
    if (merged.length === 0) {
      throw new Error(
        `Task '${leftoverBlocked[0]!.task.id}' blocked: ${leftoverBlocked[0]!.error ?? "unknown error"}`,
      );
    }
    await store.transition(
      state,
      "integrating",
      `部分任务已合并，${leftoverBlocked.map((task) => task.task.id).join(", ")} 仍阻塞`,
    );
  }

}

/** Tasks the checkpoint counts as done, plus anything already merged. */
export function completedTaskIds(state: RunState): Set<string> {
  const completed = new Set(latestCheckpoint(state).completedTaskIds);
  // Tasks merged after the latest checkpoint was recorded (crash mid-integration)
  // are already done; their commits live on the integration branch.
  for (const task of state.tasks) {
    if (task.status === "merged") completed.add(task.task.id);
  }
  return completed;
}

export function blockedTaskIds(state: RunState): Set<string> {
  return new Set(state.tasks.filter((task) => task.status === "blocked").map((task) => task.task.id));
}

/**
 * The next wave to run, `[]` when something is left but nothing can be scheduled,
 * or `undefined` when the plan is exhausted.
 */
export function plannedWave(
  state: RunState,
  completed: Set<string>,
  started: Set<string>,
): ReturnType<typeof selectTaskWave> | undefined {
  const plan = state.plan!;
  const concurrency = state.strategy.swarmMaxConcurrency ?? state.strategy.maxParallel;
  const wave = selectTaskWave(plan, completed, started, concurrency);
  if (wave.length > 0) return wave;
  const remaining = plan.tasks.filter((task) => !completed.has(task.id) && !started.has(task.id));
  return remaining.length === 0 ? undefined : [];
}

export function waveStatus(
  rejection: PromiseRejectedResult | undefined,
  passed: number,
  blocked: number,
): "failed" | "blocked" | "passed" {
  if (rejection && passed === 0 && blocked === 0) return "failed";
  return blocked > 0 ? "blocked" : "passed";
}

/** The batch keys a wave covers, without duplicates: one entry per shared batch. */
export function waveBatchKeys(
  wave: ReadonlyArray<{ batchKey?: string | null | undefined }>,
): string[] {
  return [...new Set(wave.map((task) => task.batchKey).filter((key): key is string => Boolean(key)))];
}

function byTaskId<T extends { task: { id: string } }>(left: T, right: T): number {
  return left.task.id.localeCompare(right.task.id);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Nothing can be scheduled but tasks remain: every one of them is waiting behind a
 * failure, so none of them will ever run.
 */
export function markUnfinishedBlocked(
  state: RunState,
  completed: Set<string>,
  blockedIds: Set<string>,
): string[] {
  const remaining = state.plan!.tasks.filter(
    (task) => !completed.has(task.id) && !blockedIds.has(task.id),
  );
  for (const task of remaining) {
    const taskState = findTaskState(state, task.id);
    taskState.status = "blocked";
    taskState.error = "Blocked because a dependency failed";
    blockedIds.add(task.id);
  }
  return remaining.map((task) => task.id);
}
