import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RoleAgentService, TextRoleInvocationOptions } from "../src/agents/service.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import type { LoadedConfig } from "../src/config/load.js";
import { GithubClient } from "../src/github/client.js";
import { GithubRepairRunner, type RepairPushSummary } from "../src/github/repair.js";
import type { ProcessRequest, ProcessResult } from "../src/process/run.js";
import { runProcess } from "../src/process/run.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

const integrationBranch = "agent-team/repair-run/integration";

const failedCheck = {
  bucket: "fail",
  completedAt: "2026-01-01T00:10:00Z",
  description: "The CI workflow failed",
  event: "pull_request",
  link: "https://github.com/acme/repo/actions/runs/555",
  name: "ci",
  startedAt: "2026-01-01T00:00:00Z",
  state: "failure",
  workflow: "CI",
};

describe("GithubRepairRunner", () => {
  it("repairs failed checks, pushes the fix, and returns to waiting-ci", async () => {
    const fixture = await createFixture();
    const textCalls: TextRoleInvocationOptions[] = [];
    const structuredRoles: string[] = [];
    const agent = stubAgent({
      textCalls,
      structuredRoles,
      runText: async (options) => {
        await writeFile(path.join(options.cwd!, "app.txt"), "repaired\n", "utf8");
      },
    });
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, agent);

    const result = await runner.repair(fixture.state);

    expect(result.status).toBe("waiting-ci");
    expect(result.githubRepairAttempts).toBe(1);
    expect(result.error).toBeUndefined();
    expect(structuredRoles).toEqual(["reviewer", "tester"]);
    // Failed logs fetched from gh are handed to the repair agent.
    const context = textCalls[0]?.context as { failedLogs: string; checks: unknown[] };
    expect(context.checks).toHaveLength(1);
    expect(context.failedLogs).toContain("AssertionError: expected 1 to be 2");
    // The fix was committed locally and pushed to the remote branch.
    expect((await git(fixture.worktree, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("2");
    expect(
      (await git(fixture.remoteDir, ["rev-parse", integrationBranch])).exitCode,
    ).toBe(0);
    const statuses = fixture.state.history.map((entry) => entry.status);
    expect(statuses).toContain("repairing");
    expect(statuses.at(-1)).toBe("waiting-ci");
  });

  it("pushes only after the operator confirms the commit summary", async () => {
    const fixture = await createFixture();
    const summaries: RepairPushSummary[] = [];
    const agent = stubAgent({
      runText: async (options) => {
        await writeFile(path.join(options.cwd!, "app.txt"), "repaired\n", "utf8");
      },
    });
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, agent, {
      confirmPush: async (summary) => {
        summaries.push(summary);
        return true;
      },
    });

    const result = await runner.repair(fixture.state);

    expect(result.status).toBe("waiting-ci");
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.commitMessage).toBe("fix: repair GitHub checks for repair-run");
    expect(summary.remote).toBe(fixture.loaded.config.github.remote);
    expect(summary.branch).toBe(integrationBranch);
    expect(summary.changedFiles).toContain("app.txt");
    expect(summary.additions).toBeGreaterThan(0);
    expect(
      (await git(fixture.remoteDir, ["rev-parse", integrationBranch])).exitCode,
    ).toBe(0);
  });

  it("keeps the commit local and fails the attempt when the operator declines the push", async () => {
    const fixture = await createFixture();
    const agent = stubAgent({
      runText: async (options) => {
        await writeFile(path.join(options.cwd!, "app.txt"), "repaired\n", "utf8");
      },
    });
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, agent, {
      confirmPush: async () => false,
    });

    const result = await runner.repair(fixture.state);

    expect(result.status).toBe("ci-failed");
    expect(result.error).toContain("push declined by operator");
    // The commit exists locally but nothing reached the remote.
    expect((await git(fixture.worktree, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("2");
    expect(
      (await git(fixture.remoteDir, ["rev-parse", integrationBranch])).exitCode,
    ).not.toBe(0);
  });

  it("aborts the repair when a quality command fails", async () => {
    const fixture = await createFixture();
    fixture.loaded.config.quality.commands = [
      { command: process.execPath, args: ["-e", "process.exit(1)"] },
    ];
    const agent = stubAgent({
      runText: async (options) => {
        await writeFile(path.join(options.cwd!, "app.txt"), "repaired\n", "utf8");
      },
    });
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, agent);

    const result = await runner.repair(fixture.state);

    expect(result.status).toBe("ci-failed");
    expect(result.error).toContain("failed local gates");
    // No repair commit was created and nothing reached the remote.
    expect((await git(fixture.worktree, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect(
      (await git(fixture.remoteDir, ["rev-parse", integrationBranch])).exitCode,
    ).not.toBe(0);
  });

  it("records the failure when the repaired commit cannot be pushed", async () => {
    const fixture = await createFixture();
    fixture.loaded.config.github.remote = "no-such-remote";
    const agent = stubAgent({
      runText: async (options) => {
        await writeFile(path.join(options.cwd!, "app.txt"), "repaired\n", "utf8");
      },
    });
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, agent);

    const result = await runner.repair(fixture.state);

    expect(result.status).toBe("ci-failed");
    expect(result.error).toContain("push");
    // The commit exists locally even though the push failed.
    expect((await git(fixture.worktree, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("2");
  });

  it("rejects once the configured repair attempt limit is exhausted", async () => {
    const fixture = await createFixture();
    fixture.state.githubRepairAttempts = fixture.loaded.config.github.maxRepairAttempts;
    const agent = stubAgent({});
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, agent);

    await expect(runner.repair(fixture.state)).rejects.toThrow(
      `repair limit of ${fixture.loaded.config.github.maxRepairAttempts} exceeded`,
    );
    expect(fixture.state.status).toBe("ci-failed");
    expect(fixture.state.githubRepairAttempts).toBe(1);
    expect(fixture.ghRequests).toHaveLength(0);
  });

  it("rejects runs that are not ci-failed or were never published", async () => {
    const published = await createFixture();
    const runner = new GithubRepairRunner(published.loaded, published.store, published.client, stubAgent({}));

    published.state.status = "waiting-ci";
    await expect(runner.repair(published.state)).rejects.toThrow("is not in ci-failed status");

    const unpublished = await createFixture();
    delete unpublished.state.pullRequestUrl;
    const unpublishedRunner = new GithubRepairRunner(
      unpublished.loaded,
      unpublished.store,
      unpublished.client,
      stubAgent({}),
    );
    await expect(unpublishedRunner.repair(unpublished.state)).rejects.toThrow(
      "has not been published",
    );
  });

  it("fails the attempt when the repair agent produces no changes", async () => {
    const fixture = await createFixture();
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, stubAgent({}));

    const result = await runner.repair(fixture.state);

    expect(result.status).toBe("ci-failed");
    expect(result.error).toBe("GitHub repair agent produced no changes");
  });

  it("fails the attempt when the repair touches protected paths", async () => {
    const fixture = await createFixture();
    const agent = stubAgent({
      runText: async (options) => {
        const workflows = path.join(options.cwd!, ".github", "workflows");
        await mkdir(workflows, { recursive: true });
        await writeFile(path.join(workflows, "ci.yml"), "on: push\n", "utf8");
      },
    });
    const runner = new GithubRepairRunner(fixture.loaded, fixture.store, fixture.client, agent);

    const result = await runner.repair(fixture.state);

    expect(result.status).toBe("ci-failed");
    expect(result.error).toContain("changed protected paths");
    expect(result.error).toContain(".github/workflows/ci.yml");
  });
});

interface StubAgentHooks {
  textCalls?: TextRoleInvocationOptions[];
  structuredRoles?: string[];
  runText?: (options: TextRoleInvocationOptions) => Promise<void>;
}

function stubAgent(hooks: StubAgentHooks): RoleAgentService {
  const reviewVerdict = { verdict: "approve", summary: "Repair looks right", findings: [] };
  const testVerdict = { verdict: "approve", summary: "Repair covered by checks", missingTests: [] };
  return {
    runText: async (options: TextRoleInvocationOptions) => {
      hooks.textCalls?.push(options);
      await hooks.runText?.(options);
      return { text: "repaired", profileName: "codex-worker", usedFallback: false };
    },
    runStructured: async (options: { role: string }) => {
      hooks.structuredRoles?.push(options.role);
      const value = options.role === "reviewer" ? reviewVerdict : testVerdict;
      return { value, profileName: "codex-planner", usedFallback: false, text: JSON.stringify(value) };
    },
  } as unknown as RoleAgentService;
}

function ghResult(request: ProcessRequest, stdout: string): ProcessResult {
  return {
    command: request.command,
    args: request.args,
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    signal: null,
  };
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-repair-"));
  const loaded: LoadedConfig = {
    root,
    path: path.join(root, "agent-team.yaml"),
    config: createDefaultConfig("repair-fixture"),
  };
  const store = new RunStateStore(path.join(root, ".agent-team", "runs"));

  const worktree = path.join(root, ".agent-team", "worktrees", "integration");
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init", "-b", integrationBranch]);
  await git(worktree, ["config", "user.email", "fixture@example.com"]);
  await git(worktree, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(worktree, "app.txt"), "broken\n", "utf8");
  await git(worktree, ["add", "app.txt"]);
  await git(worktree, ["commit", "-m", "initial"]);
  const remoteDir = path.join(root, "remote.git");
  await git(root, ["init", "--bare", remoteDir]);
  await git(worktree, ["remote", "add", "origin", remoteDir]);

  const ghRequests: ProcessRequest[] = [];
  const client = new GithubClient(async (request) => {
    ghRequests.push(request);
    if (request.args[0] === "pr" && request.args[1] === "checks") {
      return ghResult(request, JSON.stringify([failedCheck]));
    }
    if (request.args[0] === "run" && request.args[1] === "view") {
      return ghResult(
        request,
        "FAIL src/app.test.ts\nAssertionError: expected 1 to be 2\n",
      );
    }
    throw new Error(`Unexpected gh request: ${request.args.join(" ")}`);
  });

  return { loaded, store, client, worktree, remoteDir, ghRequests, state: fakeRun(root, worktree) };
}

async function git(cwd: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0 && args[0] !== "rev-parse") {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

function fakeRun(root: string, worktree: string): RunState {
  const now = new Date().toISOString();
  return {
    id: "repair-run",
    goal: "Repair failed GitHub checks",
    root,
    configPath: path.join(root, "agent-team.yaml"),
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch,
    integrationWorktree: worktree,
    status: "ci-failed",
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
    repository: "acme/repo",
    pullRequestUrl: "https://github.com/acme/repo/pull/42",
  };
}
