import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoadedConfig } from "../src/config/load.js";
import type { LocalEvidenceStore } from "../src/evidence/local.js";
import type { SqliteEventStore } from "../src/events/store.js";
import { runProcess } from "../src/process/run.js";
import type { RunStateStore } from "../src/state/store.js";
import type { RunState, TaskRunState } from "../src/state/types.js";
import { RunInsights, RunNotFound } from "../src/visibility/service.js";

const STATE_DIRECTORY = ".agent-team";
const COMMIT_UNREADABLE = "记录的任务提交当前不可读取";
const STAGED_EMPTY = "工作区暂无已暂存的改动";
const NOTHING_TO_SHOW = "任务尚未产生可查看的改动";

function taskState(id: string, patch: Partial<TaskRunState> = {}): TaskRunState {
  return {
    task: {
      id,
      title: `Task ${id}`,
      description: "d",
      dependsOn: [],
      ownedPaths: ["**"],
      acceptanceCommands: [],
      profile: null,
    } as TaskRunState["task"],
    status: "pending",
    attempts: 0,
    ...patch,
  };
}

function runState(tasks: TaskRunState[]): RunState {
  const now = new Date(1_700_000_000_000).toISOString();
  return {
    id: "r1",
    goal: "goal",
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "agent-team/r1/integration",
    integrationWorktree: "/tmp/r1",
    status: "running",
    createdAt: now,
    updatedAt: now,
    profileOverrides: {},
    strategy: {
      name: "balanced",
      maxParallel: 2,
      maxReworkAttempts: 2,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
    },
    tasks,
    history: [],
  } as RunState;
}

function insights(root: string, state: RunState): RunInsights {
  const loaded = {
    root,
    configPath: path.join(root, "agent-team.yaml"),
    config: { project: { stateDirectory: STATE_DIRECTORY } },
  } as unknown as LoadedConfig;
  return new RunInsights(
    loaded,
    undefined as unknown as RunStateStore,
    undefined as unknown as LocalEvidenceStore,
    undefined as unknown as SqliteEventStore,
    async () => state,
  );
}

async function git(root: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd: root, timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}

async function repoWithCommit(): Promise<{ root: string; commit: string; worktree: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-task-diff-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "file.txt"), "first\n", "utf8");
  await git(root, ["add", "file.txt"]);
  await git(root, ["commit", "-m", "first"]);
  await writeFile(path.join(root, "file.txt"), "first\nsecond\n", "utf8");
  await git(root, ["commit", "-am", "second"]);
  const commit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const worktree = path.join(root, "worktrees", "t1");
  await git(root, ["worktree", "add", "-q", "-b", "task-t1", worktree]);
  return { root, commit, worktree };
}

describe("RunInsights.taskDiff", () => {
  it("reports a recorded commit as the authoritative task diff", async () => {
    const { root, commit } = await repoWithCommit();
    const view = await insights(root, runState([taskState("t1", { commit })])).taskDiff("r1", "t1");

    expect(view).toMatchObject({ taskId: "t1", available: true, source: "commit", commit });
    expect(view.changedFiles).toEqual(["file.txt"]);
    expect(view.content).toContain("+second");
    expect(view.truncated).toBe(false);
  });

  it("says the commit is unreadable instead of hiding the task", async () => {
    const { root } = await repoWithCommit();
    const missing = "0".repeat(40);
    const view = await insights(root, runState([taskState("t1", { commit: missing })])).taskDiff(
      "r1",
      "t1",
    );

    expect(view).toEqual({
      taskId: "t1",
      available: false,
      commit: missing,
      changedFiles: [],
      truncated: false,
      detail: COMMIT_UNREADABLE,
    });
  });

  it("falls back to the staged worktree when the task carries no commit", async () => {
    const { root, worktree } = await repoWithCommit();
    await writeFile(path.join(worktree, "file.txt"), "first\nstaged\n", "utf8");
    await git(worktree, ["add", "file.txt"]);

    const view = await insights(root, runState([taskState("t1", { worktree })])).taskDiff("r1", "t1");

    expect(view).toMatchObject({
      taskId: "t1",
      available: true,
      source: "worktree",
      truncated: false,
    });
    expect(view.changedFiles).toEqual(["file.txt"]);
    expect(view.content).toContain("+staged");
  });

  it("reports an empty staging area as a worktree answer without content", async () => {
    const { root, worktree } = await repoWithCommit();

    const view = await insights(root, runState([taskState("t1", { worktree })])).taskDiff("r1", "t1");

    expect(view).toEqual({
      taskId: "t1",
      available: false,
      source: "worktree",
      changedFiles: [],
      truncated: false,
      detail: STAGED_EMPTY,
    });
  });

  it("ignores a worktree that is gone and reports the task as unchanged", async () => {
    const { root } = await repoWithCommit();
    const gone = path.join(root, "worktree-never-created");

    const view = await insights(root, runState([taskState("t1", { worktree: gone })])).taskDiff(
      "r1",
      "t1",
    );

    expect(view).toEqual({
      taskId: "t1",
      available: false,
      changedFiles: [],
      truncated: false,
      detail: NOTHING_TO_SHOW,
    });
  });

  it("treats a worktree git cannot inspect as no diff at all", async () => {
    const { root } = await repoWithCommit();
    const notARepo = await mkdtemp(path.join(tmpdir(), "agent-team-not-git-"));

    const view = await insights(root, runState([taskState("t1", { worktree: notARepo })])).taskDiff(
      "r1",
      "t1",
    );

    expect(view).toEqual({
      taskId: "t1",
      available: false,
      changedFiles: [],
      truncated: false,
      detail: NOTHING_TO_SHOW,
    });
  });

  it("reports a task that never ran as having nothing to show", async () => {
    const { root } = await repoWithCommit();

    const view = await insights(root, runState([taskState("t1")])).taskDiff("r1", "t1");

    expect(view).toEqual({
      taskId: "t1",
      available: false,
      changedFiles: [],
      truncated: false,
      detail: NOTHING_TO_SHOW,
    });
  });

  it("refuses to answer for a task id the run does not hold", async () => {
    const { root } = await repoWithCommit();

    await expect(insights(root, runState([])).taskDiff("r1", "t9")).rejects.toThrow(RunNotFound);
    await expect(insights(root, runState([])).taskDiff("r1", "t9")).rejects.toThrow(
      "Task 't9' was not found",
    );
  });
});
