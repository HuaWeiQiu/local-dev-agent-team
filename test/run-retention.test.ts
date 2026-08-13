import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import { runProcess } from "../src/process/run.js";
import { RunSupervisor } from "../src/server/supervisor.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";
import { branchSegment } from "../src/workflow/id.js";

describe("run retention cleans Git artifacts", () => {
  it("deleting a run removes its worktrees and local branches", async () => {
    const { root, loaded, baseCommit } = await createGitFixture("delete");
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const runId = "20260812T081838Z-cleanup-delete-a1b2c3";
    await makeRunWorktrees(root, worktreesRoot, baseCommit, runId);

    const events = new SqliteEventStore(path.join(stateRoot, "control.sqlite"));
    const states = new RunStateStore(path.join(stateRoot, "runs"), events);
    await states.save(terminalState(runId));
    const supervisor = new RunSupervisor(loaded, events);
    try {
      const result = await supervisor.deleteRun(runId);
      expect(result.deletedRunIds).toEqual([runId]);

      expect(await readdir(worktreesRoot).catch(() => [])).toEqual([]);
      expect(await listBranches(root, `agent-team/${branchSegment(runId)}/*`)).toEqual([]);
      expect(await states.list()).toEqual([]);
    } finally {
      await supervisor.close();
      events.close();
    }
  }, 30_000);

  it("bulk cleanup removes worktrees and branches for every deleted run", async () => {
    const { root, loaded, baseCommit } = await createGitFixture("bulk");
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const first = "20260812T081838Z-cleanup-bulk-one-a1b2c3";
    const second = "20260812T081838Z-cleanup-bulk-two-d4e5f6";
    for (const runId of [first, second]) {
      await makeRunWorktrees(root, worktreesRoot, baseCommit, runId);
    }

    const events = new SqliteEventStore(path.join(stateRoot, "control.sqlite"));
    const states = new RunStateStore(path.join(stateRoot, "runs"), events);
    await Promise.all([states.save(terminalState(first)), states.save(terminalState(second))]);
    const supervisor = new RunSupervisor(loaded, events);
    try {
      const preview = await supervisor.previewCleanup(0);
      const result = await supervisor.cleanup(preview.token);
      expect(result.deletedRunIds.sort()).toEqual([first, second].sort());

      expect(await readdir(worktreesRoot).catch(() => [])).toEqual([]);
      expect(await listBranches(root, `agent-team/${branchSegment(first)}/*`)).toEqual([]);
      expect(await listBranches(root, `agent-team/${branchSegment(second)}/*`)).toEqual([]);
      expect(await states.list()).toEqual([]);
    } finally {
      await supervisor.close();
      events.close();
    }
  }, 30_000);

  it("startup sweep removes unknown run directories but preserves known runs", async () => {
    const { root, loaded, baseCommit } = await createGitFixture("sweep");
    const stateRoot = path.join(root, ".agent-team");
    const worktreesRoot = path.join(stateRoot, "worktrees");
    const knownRunId = "20260812T081838Z-cleanup-known-a1b2c3";
    const orphanRunId = "20260812T081838Z-cleanup-orphan-d4e5f6";
    const unrelatedDir = "notes";
    for (const runId of [knownRunId, orphanRunId]) {
      await makeRunWorktrees(root, worktreesRoot, baseCommit, runId);
    }
    await writeFile(path.join(worktreesRoot, unrelatedDir), "keep me");

    const events = new SqliteEventStore(path.join(stateRoot, "control.sqlite"));
    const states = new RunStateStore(path.join(stateRoot, "runs"), events);
    await states.save(terminalState(knownRunId));
    const supervisor = new RunSupervisor(loaded, events);
    try {
      const swept = await supervisor.reconcileUnknownWorktrees();
      expect(swept.removedDirectories).toEqual([orphanRunId]);
      expect(swept.removedBranches).toBe(2);

      const entries = await readdir(worktreesRoot);
      expect(entries.sort()).toEqual([knownRunId, unrelatedDir].sort());
      expect(await listBranches(root, `agent-team/${branchSegment(orphanRunId)}/*`)).toEqual([]);
      expect(await listBranches(root, `agent-team/${branchSegment(knownRunId)}/*`)).toEqual([
        `agent-team/${branchSegment(knownRunId)}/integration`,
        `agent-team/${branchSegment(knownRunId)}/t1`,
      ]);
    } finally {
      await supervisor.close();
      events.close();
    }
  }, 30_000);
});

async function createGitFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `agent-team-${name}-`));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Agent Team Test"]);
  await git(root, ["config", "user.email", "agent-team@example.com"]);
  const config = createDefaultConfig(name);
  await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  const loaded = await loadConfig(root);
  const baseCommit = (await gitOut(root, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, loaded, baseCommit };
}

async function makeRunWorktrees(
  root: string,
  worktreesRoot: string,
  baseCommit: string,
  runId: string,
): Promise<void> {
  const segment = branchSegment(runId);
  await git(root, [
    "worktree",
    "add",
    "-b",
    `agent-team/${segment}/integration`,
    path.join(worktreesRoot, runId, "integration"),
    baseCommit,
  ]);
  await git(root, [
    "worktree",
    "add",
    "-b",
    `agent-team/${segment}/t1`,
    path.join(worktreesRoot, runId, "t1"),
    baseCommit,
  ]);
}

function terminalState(runId: string): RunState {
  const now = new Date().toISOString();
  return {
    id: runId,
    goal: "Cleanup fixture",
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: `agent-team/${branchSegment(runId)}/integration`,
    integrationWorktree: `/tmp/${runId}`,
    status: "completed",
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
    tasks: [],
    history: [],
  };
}

async function listBranches(root: string, pattern: string): Promise<string[]> {
  const result = await gitOut(root, ["branch", "--list", "--format=%(refname:short)", pattern]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitOut(cwd, args);
}

async function gitOut(cwd: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  return result;
}
