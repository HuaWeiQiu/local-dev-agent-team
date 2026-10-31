import { randomUUID } from "node:crypto";
import { type GitManager } from "../git/manager.js";
import { type RunStateStore } from "../state/store.js";
import type { ApprovalRequest, CheckpointStage, RecoveryRecord, RunCheckpoint, RunState } from "../state/types.js";
import { latestApproval, requiresPlanApproval, resetIncompleteTask } from "./state-helpers.js";
import type { WorkflowResumeOptions, RunnerEnv } from "./types.js";

export class CheckpointService {
  constructor(
    private readonly env: RunnerEnv,
  ) {}

  async recordCheckpoint(
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

  async requestApproval(
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

  async assertCheckpointMatches(
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
  async isOnlyPostCheckpointMerges(
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
  async reconcilePostCheckpointMerges(
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

  async prepareRecovery(
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
}
