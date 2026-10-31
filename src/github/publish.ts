import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedConfig } from "../config/load.js";
import { GitManager } from "../git/manager.js";
import type { RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import {
  classifyGithubFailure,
  githubActionError,
  GithubActionError,
} from "./errors.js";
import { GithubClient, summarizeChecks, type GithubCheck } from "./client.js";
import {
  markFailed,
  markSent,
  messageId,
  receiptFor,
  type EnqueueInput,
  type OutboxMessage,
} from "../authority/outbox.js";
import type { OutboxStore } from "../authority/outbox-store.js";

export class GithubPublisher {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: RunStateStore,
    private readonly client = new GithubClient(),
    /** The one write to the remote; injected so publication can be tested without a repo. */
    private readonly push: (state: RunState) => Promise<void> = async (state) =>
      await this.gitFor().push(
        state.integrationWorktree,
        this.loaded.config.github.remote,
        state.integrationBranch,
      ),
    /** Where the receipt of what was already said goes; omit it to keep today's behaviour. */
    private readonly outbox?: OutboxStore,
  ) {}

  async publish(state: RunState): Promise<RunState> {
    this.assertPublishable(state);
    await this.store.transition(state, "publishing", "Publishing integration branch to GitHub");
    try {
      await this.client.authStatus(state.integrationWorktree);
      const repository = await this.client.repository(state.integrationWorktree);
      await this.push(state);
      const receipt = await this.publicationReceipt(state);
      if (receipt?.state === "sent" && receipt.body) {
        // The pull request was created, even if we died before saying where.
        return await this.reusePublication(state, repository.nameWithOwner, receipt.body);
      }
      const pullRequest = await this.ensurePullRequest(state, repository.nameWithOwner);
      state.repository = repository.nameWithOwner;
      state.pullRequestUrl = pullRequest.url;
      state.pullRequestNumber = pullRequest.number;
      await this.recordPublication(state, pullRequest.url, receipt);
      await this.store.transition(state, "waiting-ci", `Pull request created: ${pullRequest.url}`);
      return state;
    } catch (error) {
      // Never leave a run stuck in "publishing": fall back to the
      // re-publishable state, mirroring the repair loop's ci-failed fallback.
      const classified: GithubActionError =
        error instanceof GithubActionError ? error : classifyGithubFailure(error);
      await this.recordPublicationFailure(state, classified.message);
      state.error = classified.message;
      await this.store.transition(state, "ready-to-merge", `Publication failed: ${state.error}`);
      throw classified;
    }
  }

  /**
   * What this run's publication looks like as one message to the source.
   *
   * The channel uses the configured remote, never `state.repository`: publish sets
   * that field itself, so keying on it would mean the receipt written after the
   * pull request exists lands under a different id than the one read before it.
   */
  private publicationMessage(state: RunState): EnqueueInput {
    return {
      purpose: "result",
      subjectId: state.id,
      channel: {
        sourceKind: "github",
        sourceInstanceId: this.loaded.config.github.remote,
        threadId: state.integrationBranch,
      },
      body: "",
      at: new Date().toISOString(),
    };
  }

  private async publicationReceipt(state: RunState): Promise<OutboxMessage | undefined> {
    if (!this.outbox) return undefined;
    return await this.outbox.get(messageId(this.publicationMessage(state)));
  }

  /**
   * A receipt that already says "sent" is honoured — it is the evidence that the
   * pull request exists. Answering from it is what stops a retry opening a second
   * one after a crash between creating and recording.
   */
  private async reusePublication(state: RunState, repository: string, url: string): Promise<RunState> {
    state.repository = repository;
    state.pullRequestUrl = url;
    await this.store.transition(state, "waiting-ci", `Pull request already created: ${url}`);
    return state;
  }

  private async recordPublication(
    state: RunState,
    url: string,
    existing: OutboxMessage | undefined,
  ): Promise<void> {
    if (!this.outbox) return;
    const receipt = receiptFor(this.publicationMessage(state), existing);
    await this.outbox.save(markSent({ ...receipt, body: url }, new Date().toISOString()));
  }

  private async recordPublicationFailure(state: RunState, message: string): Promise<void> {
    if (!this.outbox) return;
    const existing = await this.publicationReceipt(state);
    const receipt = receiptFor(this.publicationMessage(state), existing);
    await this.outbox.save(markFailed(receipt, new Date().toISOString(), message));
  }

  /** Publication needs integration enabled, a final approval and a publishable status. */
  private assertPublishable(state: RunState): void {
    if (!this.loaded.config.github.enabled) {
      throw githubActionError(
        "github-disabled",
        "GitHub integration is disabled in agent-team.yaml",
      );
    }
    const finalApproval = state.approvals?.filter((approval) => approval.gate === "final").at(-1);
    if (finalApproval?.status !== "approved") {
      throw githubActionError(
        "other",
        `Run '${state.id}' requires final human approval before publication`,
      );
    }
    if (!["waiting-ci", "ci-failed", "ready-to-merge"].includes(state.status)) {
      throw githubActionError(
        "other",
        `Run '${state.id}' cannot be published from status '${state.status}'`,
      );
    }
  }

  private gitFor(): GitManager {
    const worktreesRoot = path.resolve(
      this.loaded.root,
      this.loaded.config.project.stateDirectory,
      "worktrees",
    );
    return new GitManager(this.loaded.root, worktreesRoot);
  }

  /** An open pull request for this branch is reused; otherwise one is created. */
  private async ensurePullRequest(state: RunState, repository: string) {
    const existing = await this.client.findPullRequest(
      state.integrationWorktree,
      repository,
      state.integrationBranch,
    );
    if (existing) return existing;
    const artifactDirectory = this.store.artifactDirectory(state.id, "github");
    await mkdir(artifactDirectory, { recursive: true });
    const bodyFile = path.join(artifactDirectory, "pull-request.md");
    await writeFile(bodyFile, renderPullRequestBody(state), "utf8");
    return await this.client.createPullRequest({
      cwd: state.integrationWorktree,
      repository,
      base: state.baseBranch,
      head: state.integrationBranch,
      title: `[agent-team] ${state.intake?.goalSummary ?? state.goal}`.slice(0, 120),
      bodyFile,
      draft: this.loaded.config.github.draftPullRequest,
    });
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
