import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { GitManager } from "../git/manager.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { GithubClient, summarizeChecks, type GithubCheck } from "./client.js";

export class GithubPublisher {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: RunStateStore,
    private readonly client = new GithubClient(),
  ) {}

  async publish(state: RunState): Promise<RunState> {
    if (!this.loaded.config.github.enabled) {
      throw new Error("GitHub integration is disabled in agent-team.yaml");
    }
    if (!['awaiting-human', 'waiting-ci', 'ci-failed', 'ready-to-merge'].includes(state.status)) {
      throw new Error(`Run '${state.id}' cannot be published from status '${state.status}'`);
    }
    await this.store.transition(state, "publishing", "Publishing integration branch to GitHub");
    await this.client.authStatus(state.integrationWorktree);
    const repository = await this.client.repository(state.integrationWorktree);
    const worktreesRoot = path.resolve(
      this.loaded.root,
      this.loaded.config.project.stateDirectory,
      "worktrees",
    );
    const git = new GitManager(this.loaded.root, worktreesRoot);
    await git.push(
      state.integrationWorktree,
      this.loaded.config.github.remote,
      state.integrationBranch,
    );

    let pullRequest = await this.client.findPullRequest(
      state.integrationWorktree,
      repository.nameWithOwner,
      state.integrationBranch,
    );
    if (!pullRequest) {
      const artifactDirectory = this.store.artifactDirectory(state.id, "github");
      await mkdir(artifactDirectory, { recursive: true });
      const bodyFile = path.join(artifactDirectory, "pull-request.md");
      await writeFile(bodyFile, renderPullRequestBody(state), "utf8");
      pullRequest = await this.client.createPullRequest({
        cwd: state.integrationWorktree,
        repository: repository.nameWithOwner,
        base: state.baseBranch,
        head: state.integrationBranch,
        title: `[agent-team] ${state.intake?.goalSummary ?? state.goal}`.slice(0, 120),
        bodyFile,
        draft: this.loaded.config.github.draftPullRequest,
      });
    }
    state.repository = repository.nameWithOwner;
    state.pullRequestUrl = pullRequest.url;
    state.pullRequestNumber = pullRequest.number;
    await this.store.transition(state, "waiting-ci", `Pull request created: ${pullRequest.url}`);
    return state;
  }

  async refreshChecks(state: RunState, wait: boolean): Promise<GithubCheck[]> {
    if (!state.repository || !state.pullRequestUrl) {
      throw new Error(`Run '${state.id}' has not been published`);
    }
    const checks = wait
      ? await this.client.waitForChecks({
          cwd: state.integrationWorktree,
          repository: state.repository,
          target: state.pullRequestUrl,
          timeoutSeconds: this.loaded.config.github.checkTimeoutSeconds,
        })
      : await this.client.checks(
          state.integrationWorktree,
          state.repository,
          state.pullRequestUrl,
        );
    const summary = summarizeChecks(checks);
    if (summary === "pass") {
      await this.store.transition(state, "ready-to-merge", "GitHub checks passed; human merge required");
    } else if (summary === "fail") {
      await this.store.transition(state, "ci-failed", "One or more GitHub checks failed");
    } else {
      await this.store.transition(state, "waiting-ci", `GitHub checks are ${summary}`);
    }
    return checks;
  }

  async markCompletedIfMerged(state: RunState): Promise<boolean> {
    if (!state.repository || !state.pullRequestUrl) {
      throw new Error(`Run '${state.id}' has not been published`);
    }
    const pullRequest = await this.client.pullRequest(
      state.integrationWorktree,
      state.repository,
      state.pullRequestUrl,
    );
    if (!pullRequest.mergedAt) {
      return false;
    }
    await this.store.transition(state, "completed", `Pull request merged at ${pullRequest.mergedAt}`);
    return true;
  }
}

function renderPullRequestBody(state: RunState): string {
  const tasks = state.tasks
    .map(
      (task) =>
        `- \`${task.task.id}\` ${task.task.title}: ${task.status}, attempts=${task.attempts}, profile=${task.profile ?? "unknown"}`,
    )
    .join("\n");
  const commands = state.finalQuality?.commands
    .map(
      (command) =>
        `- \`${[command.spec.command, ...command.spec.args].join(" ")}\`: ${command.exitCode === 0 ? "passed" : "failed"}`,
    )
    .join("\n") || "- No project-level commands configured.";
  return `## Goal

${state.goal}

## Agent Tasks

${tasks}

## Final Local Checks

${commands}

## Merge Policy

This pull request was created by Local Dev Agent Team. Automatic merge is disabled. A human must inspect the diff and merge it explicitly.

Run ID: \`${state.id}\`
`;
}
