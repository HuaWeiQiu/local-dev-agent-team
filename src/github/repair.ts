import { minimatch } from "minimatch";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { RoleAgentService } from "../agents/service.js";
import { ProfiledAgentService } from "../agents/service.js";
import {
  reviewVerdictSchema,
  testVerdictSchema,
} from "../domain/contracts.js";
import {
  reviewVerdictJsonSchema,
  testVerdictJsonSchema,
} from "../domain/json-schemas.js";
import { GitManager } from "../git/manager.js";
import { runQualityCommands } from "../quality/run.js";
import {
  createExecutionDeadline,
  RunBudgetTracker,
} from "../observability/budget.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { GithubClient } from "./client.js";

export interface RepairPushSummary {
  commitMessage: string;
  remote: string;
  branch: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
}

export interface GithubRepairOptions {
  /**
   * Human gate before the repair commit is pushed. Return false to abort the
   * push; the attempt then fails back to ci-failed without touching the remote.
   * When omitted (automation/tests), the push proceeds as before.
   */
  confirmPush?: (summary: RepairPushSummary) => Promise<boolean>;
}

function assertRepairable(state: RunState): void {
  if (state.status !== "ci-failed") {
    throw new Error(`Run '${state.id}' is not in ci-failed status`);
  }
  if (!state.repository || !state.pullRequestUrl) {
    throw new Error(`Run '${state.id}' has not been published`);
  }
}

function nextRepairAttempt(state: RunState, maxAttempts: number): number {
  const attempt = (state.githubRepairAttempts ?? 0) + 1;
  if (attempt > maxAttempts) {
    throw new Error(`GitHub repair limit of ${maxAttempts} exceeded`);
  }
  return attempt;
}

function assertRepairChangedSomething(changedFiles: string[]): void {
  if (changedFiles.length > 0) return;
  throw new Error("GitHub repair agent produced no changes");
}

function forbiddenRepairPaths(changedFiles: string[], patterns: string[]): string[] {
  return changedFiles.filter((file) =>
    patterns.some((pattern) => minimatch(file, pattern, { dot: true })),
  );
}

function assertRepairPathsAllowed(changedFiles: string[], patterns: string[]): void {
  const forbidden = forbiddenRepairPaths(changedFiles, patterns);
  if (forbidden.length === 0) return;
  throw new Error(`GitHub repair changed protected paths: ${forbidden.join(", ")}`);
}

/** Both reviewers must approve and the local gates must pass. */
function assertRepairPassed(
  quality: { passed: boolean },
  verdicts: {
    review: { verdict: string; findings: Array<{ required: boolean }>; summary: string };
    test: { verdict: string; summary: string };
  },
): void {
  const approved =
    quality.passed &&
    verdicts.review.verdict === "approve" &&
    !verdicts.review.findings.some((finding) => finding.required) &&
    verdicts.test.verdict === "approve";
  if (approved) return;
  throw new Error(
    `GitHub repair failed local gates: ${verdicts.review.summary}; ${verdicts.test.summary}`,
  );
}

export class GithubRepairRunner {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: RunStateStore,
    private readonly client = new GithubClient(),
    private readonly agent?: RoleAgentService,
    private readonly options: GithubRepairOptions = {},
  ) {}

  async repair(state: RunState): Promise<RunState> {
    assertRepairable(state);
    const attempt = nextRepairAttempt(state, this.loaded.config.github.maxRepairAttempts);
    state.githubRepairAttempts = attempt;
    await this.store.transition(state, "repairing", `Repairing failed GitHub checks, attempt ${attempt}`);

    const worktreesRoot = path.resolve(
      this.loaded.root,
      this.loaded.config.project.stateDirectory,
      "worktrees",
    );
    const git = new GitManager(this.loaded.root, worktreesRoot);
    const checks = await this.client.checks(
      state.integrationWorktree,
      state.repository!,
      state.pullRequestUrl!,
    );
    const failedLogs = await this.client.failedLogs(
      state.integrationWorktree,
      state.repository!,
      checks,
    );
    const budget = new RunBudgetTracker(state, this.store);
    const deadline = createExecutionDeadline(state.strategy.executionTimeoutSeconds);
    const agent = this.repairAgent(state, deadline, budget);

    try {
      const quality = await this.runRepairWorker({ state, agent, attempt, checks, failedLogs, deadline });
      const { changedFiles, diff } = await this.stagedRepair(state, git);
      const verdicts = await this.repairVerdicts({
        state,
        agent,
        attempt,
        changedFiles,
        diff,
        quality,
        failedLogs,
      });
      assertRepairPassed(quality, verdicts);
      await this.commitAndPush({ state, git, changedFiles, diff });
      delete state.error;
      await this.store.transition(state, "waiting-ci", "GitHub repair pushed; waiting for new checks");
      return state;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      await this.store.transition(state, "ci-failed", state.error);
      return state;
    } finally {
      deadline.dispose();
    }
  }

  private repairAgent(
    state: RunState,
    deadline: ReturnType<typeof createExecutionDeadline>,
    budget: RunBudgetTracker,
  ): RoleAgentService {
    return this.agent ?? new ProfiledAgentService(
      this.loaded.config,
      this.loaded.root,
      this.store,
      state.profileOverrides,
      deadline.signal,
      budget,
    );
  }

  /** One worker pass, then the local quality gates the repository already declares. */
  private async runRepairWorker(input: {
    state: RunState;
    agent: RoleAgentService;
    attempt: number;
    checks: Awaited<ReturnType<GithubRepairRunner["client"]["checks"]>>;
    failedLogs: string;
    deadline: ReturnType<typeof createExecutionDeadline>;
  }): Promise<Awaited<ReturnType<typeof runQualityCommands>>> {
    const { state, agent, attempt, checks, failedLogs, deadline } = input;
    await agent.runText({
      role: "worker",
      cwd: state.integrationWorktree,
      runId: state.id,
      artifactKey: `github-repair/attempt-${attempt}/worker`,
      context: {
        goal: state.goal,
        task: {
          id: `github-repair-${attempt}`,
          title: "Repair failed GitHub Actions checks",
          description: "Reproduce and minimally fix the failed checks shown below.",
          ownedPaths: ["**"],
        },
        checks,
        failedLogs,
        forbiddenPaths: this.loaded.config.github.repairForbiddenPaths,
      },
    });
    const quality = await runQualityCommands(
      state.integrationWorktree,
      this.loaded.config.quality.commands,
      this.loaded.config.quality.commandTimeoutSeconds,
      this.store.artifactDirectory(state.id, `github-repair/attempt-${attempt}/quality`),
      deadline.signal,
      { maxOutputBytes: state.strategy.maxProcessOutputBytes },
    );
    await new RunBudgetTracker(state, this.store).recordQuality(quality);
    return quality;
  }

  /** Stage what the worker wrote, refuse an empty or forbidden change set, and capture the diff. */
  private async stagedRepair(
    state: RunState,
    git: GitManager,
  ): Promise<{ changedFiles: string[]; diff: string }> {
    await git.stage(state.integrationWorktree);
    const changedFiles = await git.changedFiles(state.integrationWorktree);
    assertRepairChangedSomething(changedFiles);
    assertRepairPathsAllowed(changedFiles, this.loaded.config.github.repairForbiddenPaths);
    return { changedFiles, diff: await git.stagedDiff(state.integrationWorktree) };
  }

  private async repairVerdicts(input: {
    state: RunState;
    agent: RoleAgentService;
    attempt: number;
    changedFiles: string[];
    diff: string;
    quality: Awaited<ReturnType<typeof runQualityCommands>>;
    failedLogs: string;
  }) {
    const { state, agent, attempt, changedFiles, diff, quality, failedLogs } = input;
    const [review, test] = await Promise.all([
      agent.runStructured({
        role: "reviewer",
        cwd: state.integrationWorktree,
        runId: state.id,
        artifactKey: `github-repair/attempt-${attempt}/review`,
        context: { goal: state.goal, changedFiles, diff, failedLogs },
        schema: reviewVerdictSchema,
        jsonSchema: reviewVerdictJsonSchema,
      }),
      agent.runStructured({
        role: "tester",
        cwd: state.integrationWorktree,
        runId: state.id,
        artifactKey: `github-repair/attempt-${attempt}/test`,
        context: { goal: state.goal, changedFiles, diff, quality, failedLogs },
        schema: testVerdictSchema,
        jsonSchema: testVerdictJsonSchema,
      }),
    ]);
    return { review: review.value, test: test.value };
  }

  private async commitAndPush(input: {
    state: RunState;
    git: GitManager;
    changedFiles: string[];
    diff: string;
  }): Promise<void> {
    const { state, git, changedFiles, diff } = input;
    await git.stage(state.integrationWorktree);
    const commitMessage = `fix: repair GitHub checks for ${state.id}`;
    await git.commit(state.integrationWorktree, commitMessage);
    if (this.options.confirmPush) {
      const confirmed = await this.options.confirmPush({
        commitMessage,
        remote: this.loaded.config.github.remote,
        branch: state.integrationBranch,
        changedFiles,
        ...diffStat(diff),
      });
      if (!confirmed) throw new Error("GitHub repair push declined by operator");
    }
    await git.push(
      state.integrationWorktree,
      this.loaded.config.github.remote,
      state.integrationBranch,
    );
  }

}

/** Approximate `git diff --stat` counters from a unified diff body. */
function diffStat(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}
