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

export interface PublishPreview {
  eligible: boolean;
  reason?: string;
  repository?: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  title: string;
  body: string;
  warnings: string[];
  checks: {
    ghAuthenticated: boolean;
    repoAccess: boolean;
    baseOnRemote: boolean;
    headAheadOfBase: boolean;
  };
}

export interface PublishOptions {
  title?: string;
  body?: string;
  /** Explicitly push a local-only base branch before creating the PR. */
  pushBaseBranch?: boolean;
  /** Per-publish draft override; defaults to the project config. */
  draft?: boolean;
}

const prTypeByPrefix: Record<string, string> = {
  feature: "feat",
  feat: "feat",
  fix: "fix",
  chore: "chore",
  docs: "docs",
  refactor: "refactor",
  test: "test",
};

export function renderPullRequestTitle(state: RunState): string {
  const prefix = state.integrationBranch.split("/")[0] ?? "agent-team";
  const type = prTypeByPrefix[prefix] ?? "feat";
  const goal = compactText(state.intake?.goalSummary ?? state.goal);
  return `${type}: ${goal}`.slice(0, 120);
}

export async function renderPullRequestBody(
  state: RunState,
  git: GitManager,
): Promise<string> {
  const tasks = state.tasks
    .map((task) => {
      const outcome = task.status === "merged" ? "已完成" : task.status === "passed" ? "已通过" : task.status;
      const summary = task.review?.summary ?? task.test?.summary ?? "";
      return `| \`${task.task.id}\` | ${compactText(task.task.title)} | ${outcome}${summary ? `：${compactText(summary, 120)}` : ""} |`;
    })
    .join("\n") || "| - | 本运行未拆分为任务 | - |";

  const commands = state.finalQuality?.commands
    .map(
      (command) =>
        `- \`${[command.spec.command, ...command.spec.args].join(" ")}\`: ${command.exitCode === 0 ? "通过" : "失败"}`,
    )
    .join("\n") || "- 未配置项目级验证命令。";

  let diffSummary = "- 没有可用的集成 diff。";
  let commitLines = "";
  try {
    diffSummary = (await git.diffSummary(state.integrationWorktree, state.baseCommit)) || diffSummary;
    const subjects = await git.commitSubjects(state.integrationWorktree, state.baseCommit, "HEAD");
    commitLines = [...subjects.values()]
      .slice(-10)
      .map((subject) => `- ${compactText(subject, 160)}`)
      .join("\n");
  } catch {
    // The integration worktree may be gone for legacy states; keep the template stable.
  }

  const verdict = state.finalDecision
    ? `- 最终判定：\`${state.finalDecision.decision}\` — ${compactText(state.finalDecision.reason, 200)}`
    : "- 最终判定：无";
  const verification = state.finalQuality?.passed
    ? "通过"
    : state.finalQuality
      ? "未通过"
      : "未执行";

  return `## 目标

${state.goal}

## 方案

${compactText(state.plan?.summary ?? "计划摘要不可用（旧运行或无计划）。", 600)}

| 任务 | 内容 | 结果 |
| --- | --- | --- |
${tasks}

## 执行

${renderExecutionSummary(state)}

## 实现

\`\`\`text
${diffSummary}
\`\`\`

${commitLines ? `关键提交：\n${commitLines}` : ""}

## 验证

本地项目门禁：${verification}

${commands}

${verdict}

## 合并策略

- 本 PR 由 Local Dev Agent Team 创建，**不会自动合并**。
- 请人工审查 diff 与检查结果后合并。
- 运行 ID：\`${state.id}\`
`;
}

export class GithubPublisher {
  constructor(
    private readonly loaded: LoadedConfig,
    private readonly store: RunStateStore,
    private readonly client = new GithubClient(),
  ) {}

  async preview(state: RunState): Promise<PublishPreview> {
    const draft = this.loaded.config.github.draftPullRequest;
    const warnings: string[] = [];
    const checks = {
      ghAuthenticated: false,
      repoAccess: false,
      baseOnRemote: false,
      headAheadOfBase: false,
    };
    let repository: string | undefined;
    try {
      await this.client.authStatus(state.integrationWorktree);
      checks.ghAuthenticated = true;
    } catch {
      warnings.push("还没连接 GitHub，无法创建 PR。请先在项目 Git 里点「连接 GitHub」。");
    }
    try {
      repository = (await this.client.repository(state.integrationWorktree)).nameWithOwner;
      checks.repoAccess = true;
    } catch {
      warnings.push("无法读取远端仓库信息（权限不足或网络不可达）");
    }

    const git = new GitManager(
      this.loaded.root,
      path.resolve(this.loaded.root, this.loaded.config.project.stateDirectory, "worktrees"),
    );
    try {
      checks.baseOnRemote = (await git.remoteBranches(this.loaded.config.github.remote)).has(
        state.baseBranch,
      );
      if (!checks.baseOnRemote) {
        warnings.push(`base 分支 '${state.baseBranch}' 不在远端，发布前需要先推送它`);
      }
    } catch {
      warnings.push("无法读取远端分支列表");
    }
    try {
      const ahead = await git.commitsBetween(
        state.integrationWorktree,
        state.baseCommit,
        "HEAD",
      );
      checks.headAheadOfBase = ahead.length > 0;
      if (!checks.headAheadOfBase) {
        warnings.push("工作分支与 base 之间没有新提交");
      }
    } catch {
      checks.headAheadOfBase = false;
    }
    if (draft) {
      warnings.push("当前项目配置为草稿 PR；如需正式 PR 请在项目 Git 面板关闭草稿开关");
    }

    const eligibleReason = publishEligibilityReason(this.loaded, state);
    return {
      eligible: eligibleReason === undefined,
      ...(eligibleReason ? { reason: eligibleReason } : {}),
      ...(repository ? { repository } : {}),
      baseBranch: state.baseBranch,
      headBranch: state.integrationBranch,
      draft,
      title: renderPullRequestTitle(state),
      body: await renderPullRequestBody(state, git),
      warnings,
      checks,
    };
  }

  async publish(state: RunState, options: PublishOptions = {}): Promise<RunState> {
    if (!this.loaded.config.github.enabled) {
      throw githubActionError(
        "github-disabled",
        "GitHub integration is disabled in agent-team.yaml",
      );
    }
    const ineligible = publishEligibilityReason(this.loaded, state);
    if (ineligible) {
      throw githubActionError("other", ineligible);
    }
    await this.store.transition(state, "publishing", "Publishing integration branch to GitHub");
    try {
      await this.client.authStatus(state.integrationWorktree);
      const repository = await this.client.repository(state.integrationWorktree);
      const worktreesRoot = path.resolve(
        this.loaded.root,
        this.loaded.config.project.stateDirectory,
        "worktrees",
      );
      const git = new GitManager(this.loaded.root, worktreesRoot);

      const remoteBranches = await git.remoteBranches(this.loaded.config.github.remote);
      if (!remoteBranches.has(state.baseBranch)) {
        if (!options.pushBaseBranch) {
          throw githubActionError(
            "base-missing",
            `base 分支 '${state.baseBranch}' 不在远端；发布预览会提示先推送 base 分支，请在预览中确认后重试`,
          );
        }
        await git.push(
          state.integrationWorktree,
          this.loaded.config.github.remote,
          state.baseBranch,
        );
      }
      await git.push(
        state.integrationWorktree,
        this.loaded.config.github.remote,
        state.integrationBranch,
      );

      const draft = options.draft ?? this.loaded.config.github.draftPullRequest;
      let pullRequest = await this.client.findPullRequest(
        state.integrationWorktree,
        repository.nameWithOwner,
        state.integrationBranch,
      );
      if (!pullRequest) {
        const artifactDirectory = this.store.artifactDirectory(state.id, "github");
        await mkdir(artifactDirectory, { recursive: true });
        const bodyFile = path.join(artifactDirectory, "pull-request.md");
        const body = options.body?.trim()
          ? options.body
          : await renderPullRequestBody(state, git);
        await writeFile(bodyFile, body, "utf8");
        pullRequest = await this.client.createPullRequest({
          cwd: state.integrationWorktree,
          repository: repository.nameWithOwner,
          base: state.baseBranch,
          head: state.integrationBranch,
          title: validatePublishTitle(options.title ?? renderPullRequestTitle(state)),
          bodyFile,
          draft,
        });
      } else if (pullRequest.isDraft && !draft) {
        // A previous publish created a draft; promote it to a reviewable PR.
        await this.client.markPullRequestReady(
          state.integrationWorktree,
          repository.nameWithOwner,
          pullRequest.url,
        );
        pullRequest = await this.client.pullRequest(
          state.integrationWorktree,
          repository.nameWithOwner,
          pullRequest.url,
        );
      }
      state.repository = repository.nameWithOwner;
      state.pullRequestUrl = pullRequest.url;
      state.pullRequestNumber = pullRequest.number;
      await this.store.transition(state, "waiting-ci", `Pull request created: ${pullRequest.url}`);
      return state;
    } catch (error) {
      // Never leave a run stuck in "publishing": fall back to the
      // re-publishable state, mirroring the repair loop's ci-failed fallback.
      const classified: GithubActionError =
        error instanceof GithubActionError ? error : classifyGithubFailure(error);
      state.error = classified.message;
      await this.store.transition(state, "ready-to-merge", `Publication failed: ${state.error}`);
      throw classified;
    }
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

function publishEligibilityReason(loaded: LoadedConfig, state: RunState): string | undefined {
  if (!loaded.config.github.enabled) {
    return "项目配置已关闭 GitHub 集成（agent-team.yaml 的 github.enabled: false）";
  }
  const finalApproval = state.approvals
    ?.filter((approval) => approval.gate === "final")
    .at(-1);
  if (finalApproval?.status !== "approved") {
    return `Run '${state.id}' requires final human approval before publication`;
  }
  if (!["waiting-ci", "ci-failed", "ready-to-merge"].includes(state.status)) {
    return `Run '${state.id}' cannot be published from status '${state.status}'`;
  }
  return undefined;
}

function validatePublishTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("Pull request title must not be empty");
  }
  if (trimmed.length > 120) {
    throw new Error(`Pull request title must be at most 120 characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function compactText(value: string, maxCharacters = 200): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxCharacters
    ? compact
    : `${compact.slice(0, maxCharacters - 1)}…`;
}

function renderExecutionSummary(state: RunState): string {
  const summaries = state.stageSummaries
    ?.filter((summary) =>
      ["implementing", "integrating", "reviewing-testing", "final-checks"].includes(
        summary.stage,
      ),
    )
    .map((summary) => `- **${summary.title}**：${summary.summary}`);
  if (summaries?.length) {
    return summaries.join("\n");
  }
  const merged = state.tasks.filter((task) => task.status === "merged").length;
  return `- 任务执行：${merged}/${state.tasks.length} 个任务已合并到工作分支。`;
}
