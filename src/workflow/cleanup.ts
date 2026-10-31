import { readdir } from "node:fs/promises";
import path from "node:path";
import type { GitManager } from "../git/manager.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { branchSegment } from "./id.js";

/** Removes a terminal run's task worktrees and branches; failures only become warnings. */
export class RunArtifactCleaner {
  constructor(private readonly worktreesDirectory: string) {}

  async warn(
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
  async cleanup(
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
        await this.warn(
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
          await this.warn(
            state,
            store,
            `Failed to delete task branch '${branch}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      await this.warn(
        state,
        store,
        `Failed to list task branches for cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
