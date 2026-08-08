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

export class GithubRepairRunner {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: RunStateStore,
    private readonly client = new GithubClient(),
    private readonly agent?: RoleAgentService,
  ) {}

  async repair(state: RunState): Promise<RunState> {
    if (state.status !== "ci-failed") {
      throw new Error(`Run '${state.id}' is not in ci-failed status`);
    }
    if (!state.repository || !state.pullRequestUrl) {
      throw new Error(`Run '${state.id}' has not been published`);
    }
    const attempt = (state.githubRepairAttempts ?? 0) + 1;
    if (attempt > this.loaded.config.github.maxRepairAttempts) {
      throw new Error(
        `GitHub repair limit of ${this.loaded.config.github.maxRepairAttempts} exceeded`,
      );
    }
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
      state.repository,
      state.pullRequestUrl,
    );
    const failedLogs = await this.client.failedLogs(
      state.integrationWorktree,
      state.repository,
      checks,
    );
    const budget = new RunBudgetTracker(state, this.store);
    const deadline = createExecutionDeadline(state.strategy.executionTimeoutSeconds);
    const agent =
      this.agent ??
      new ProfiledAgentService(
        this.loaded.config,
        this.loaded.root,
        this.store,
        state.profileOverrides,
        deadline.signal,
        budget,
      );

    try {
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
      await budget.recordQuality(quality);
      await git.stage(state.integrationWorktree);
      const changedFiles = await git.changedFiles(state.integrationWorktree);
      if (changedFiles.length === 0) {
        throw new Error("GitHub repair agent produced no changes");
      }
      const forbidden = changedFiles.filter((file) =>
        this.loaded.config.github.repairForbiddenPaths.some((pattern) =>
          minimatch(file, pattern, { dot: true }),
        ),
      );
      if (forbidden.length > 0) {
        throw new Error(`GitHub repair changed protected paths: ${forbidden.join(", ")}`);
      }
      const diff = await git.stagedDiff(state.integrationWorktree);
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
      const passed =
        quality.passed &&
        review.value.verdict === "approve" &&
        !review.value.findings.some((finding) => finding.required) &&
        test.value.verdict === "approve";
      if (!passed) {
        throw new Error(
          `GitHub repair failed local gates: ${review.value.summary}; ${test.value.summary}`,
        );
      }
      await git.stage(state.integrationWorktree);
      await git.commit(
        state.integrationWorktree,
        `fix: repair GitHub checks for ${state.id}`,
      );
      await git.push(
        state.integrationWorktree,
        this.loaded.config.github.remote,
        state.integrationBranch,
      );
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
}
