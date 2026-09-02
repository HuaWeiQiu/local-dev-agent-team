import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  accountFromProbe,
  githubHostFromRemoteUrl,
  type GithubAccountSnapshot,
} from "../github/auth.js";
import { GithubClient } from "../github/client.js";
import { runProcess, type ProcessResult } from "../process/run.js";
import {
  GitManager,
  normalizeRepositoryRelativePath,
  type GitChangeFile,
  type GitWorktreeDiff,
} from "./manager.js";
import { remoteOwnerAllowed } from "./remote-policy.js";

export type GitBlocker =
  | "git-missing"
  | "not-a-repository"
  | "root-mismatch"
  | "dirty-worktree"
  | "no-commits"
  | "no-remote"
  | "remote-unreachable"
  | "gh-missing"
  | "gh-not-authenticated"
  | "gh-no-repo-access"
  | "remote-not-allowed";

export interface GitEnvironmentStatus {
  gitInstalled: boolean;
  gitVersion?: string;
  isRepository: boolean;
  repoRootMatches: boolean;
  worktreeClean: boolean;
  hasCommits: boolean;
  currentBranch?: string;
  remote: string;
  remoteConfigured: boolean;
  remoteAccessible: boolean;
  localDefaultBranch?: string;
  remoteDefaultBranch?: string;
  defaultBranchSource: "gh" | "git" | "config";
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghRepoAccess: boolean;
  canSync: boolean;
  canPublish: boolean;
  blockers: GitBlocker[];
  dirtyFiles: DirtyWorktreeFile[];
  dirtyReason?: string;
  remoteUrl?: string;
  remoteOwner?: string;
  remoteAllowed: boolean;
  remotePolicyReason?: string;
  githubAccount?: GithubAccountSnapshot;
  changeSummary?: {
    files: number;
    insertions: number;
    deletions: number;
  };
  canCommit?: boolean;
  canPushBranch?: boolean;
  aheadBehind?: { ahead: number; behind: number };
}

export interface DirtyWorktreeFile {
  path: string;
  status: string;
  origin: "user" | "agent";
}

export interface BranchInfo {
  name: string;
  kind: "local" | "remote";
  commit: string;
  isDefault: boolean;
  isCurrent: boolean;
  temporary?: boolean;
}

export interface BranchSyncResult {
  branch: string;
  previousCommit?: string | undefined;
  newCommit: string;
  changed: boolean;
}

export type BranchListScope = "local" | "remote" | "all";

export class GitActionError extends Error {
  constructor(
    readonly code:
      | GitBlocker
      | "invalid-name"
      | "branch-exists"
      | "non-fast-forward"
      | "clean-worktree"
      | "no-git-identity"
      | "conflict"
      | "detached-head"
      | "behind-remote"
      | "empty-selection",
    message: string,
  ) {
    super(message);
    this.name = "GitActionError";
  }
}

export interface GithubProbeResult {
  installed: boolean;
  authenticated: boolean;
  repoAccess: boolean;
  defaultBranch?: string | undefined;
  login?: string | undefined;
  scopes?: string[] | undefined;
  tokenSource?: GithubAccountSnapshot["tokenSource"];
  gitProtocol?: GithubAccountSnapshot["gitProtocol"];
  repoNameWithOwner?: string | undefined;
  host?: string | undefined;
}

export type GithubProbe = (cwd: string) => Promise<GithubProbeResult>;

export interface GitProjectServiceOptions {
  root: string;
  worktreesRoot: string;
  remote: string;
  configDefaultBranch: string;
  allowedOwners?: string[];
  probeGithub?: GithubProbe;
}

const defaultProbeGithub: GithubProbe = async (cwd): Promise<GithubProbeResult> => {
  const remoteUrl = (await capture("git", ["remote", "get-url", "origin"], cwd)).stdout.trim();
  const host = githubHostFromRemoteUrl(remoteUrl || undefined);
  const client = new GithubClient();
  const snapshot = await client.authSnapshot(cwd, host);
  if (!snapshot.installed) {
    return { installed: false, authenticated: false, repoAccess: false, host };
  }
  const result = await capture("gh", ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"], cwd);
  if (result.exitCode !== 0) {
    return {
      installed: true,
      authenticated: snapshot.authenticated,
      repoAccess: false,
      host,
      ...(snapshot.login ? { login: snapshot.login } : {}),
      scopes: snapshot.scopes,
      ...(snapshot.tokenSource ? { tokenSource: snapshot.tokenSource } : {}),
      ...(snapshot.gitProtocol ? { gitProtocol: snapshot.gitProtocol } : {}),
    };
  }
  let defaultBranch: string | undefined;
  let repoNameWithOwner: string | undefined;
  try {
    const value = JSON.parse(result.stdout) as {
      defaultBranchRef?: { name?: string };
      nameWithOwner?: string;
    };
    defaultBranch = value.defaultBranchRef?.name;
    repoNameWithOwner = value.nameWithOwner;
  } catch {
    defaultBranch = undefined;
  }
  return {
    installed: true,
    authenticated: snapshot.authenticated,
    repoAccess: true,
    host,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(snapshot.login ? { login: snapshot.login } : {}),
    scopes: snapshot.scopes,
    ...(snapshot.tokenSource ? { tokenSource: snapshot.tokenSource } : {}),
    ...(snapshot.gitProtocol ? { gitProtocol: snapshot.gitProtocol } : {}),
    ...(repoNameWithOwner ? { repoNameWithOwner } : {}),
  };
};

export class GitProjectService {
  private readonly manager: GitManager;
  private readonly probeGithub: GithubProbe;

  constructor(private readonly options: GitProjectServiceOptions) {
    this.manager = new GitManager(options.root, options.worktreesRoot);
    this.probeGithub = options.probeGithub ?? defaultProbeGithub;
  }

  private get remote(): string {
    return this.options.remote;
  }

  private get configDefaultBranch(): string {
    return this.options.configDefaultBranch;
  }

  async status(): Promise<GitEnvironmentStatus> {
    const gitVersion = await capture("git", ["--version"], this.options.root);
    const gitInstalled = gitVersion.exitCode === 0;
    if (!gitInstalled) {
      return this.environment(false, undefined, emptyEnvironmentProbe(), {
        installed: false,
        authenticated: false,
        repoAccess: false,
      });
    }

    const topLevel = await capture(
      "git",
      ["rev-parse", "--show-toplevel"],
      this.options.root,
    );
    const isRepository = topLevel.exitCode === 0;
    const remoteProbe = await capture(
      "git",
      ["remote", "get-url", this.remote],
      this.options.root,
    );
    const remoteConfigured = remoteProbe.exitCode === 0;
    const remoteUrl = remoteConfigured ? remoteProbe.stdout.trim() : undefined;
    const remotePolicy = remoteUrl
      ? remoteOwnerAllowed(remoteUrl, this.options.allowedOwners ?? [])
      : { allowed: (this.options.allowedOwners ?? []).length === 0 };

    let repoRootMatches = false;
    if (isRepository) {
      try {
        const [gitRoot, configuredRoot] = await Promise.all([
          realpath(topLevel.stdout.trim()),
          realpath(this.options.root),
        ]);
        repoRootMatches = gitRoot === configuredRoot;
      } catch {
        repoRootMatches = false;
      }
    }

    let worktreeClean = false;
    let hasCommits = false;
    let currentBranch: string | undefined;
    let localDefaultBranch: string | undefined;
    let remoteDefaultBranch: string | undefined;
    let remoteAccessible = false;
    let defaultBranchSource: GitEnvironmentStatus["defaultBranchSource"] = "config";
    let dirtyFiles: DirtyWorktreeFile[] = [];
    let changeSummary: GitEnvironmentStatus["changeSummary"];
    let aheadBehind: GitEnvironmentStatus["aheadBehind"];
    let canCommit = false;

    if (isRepository && repoRootMatches) {
      try {
        const changes = await this.manager.changeSnapshot(this.options.root);
        dirtyFiles = changes.files.map((file) => ({
          path: file.path,
          status: file.status,
          origin: file.origin,
        }));
        worktreeClean = dirtyFiles.length === 0;
        changeSummary = {
          files: changes.files.length,
          insertions: changes.insertions,
          deletions: changes.deletions,
        };
        aheadBehind = { ahead: changes.ahead, behind: changes.behind };
        hasCommits =
          (await capture("git", ["rev-parse", "--verify", "HEAD"], this.options.root))
            .exitCode === 0;
        canCommit = dirtyFiles.length > 0 && hasCommits;
        currentBranch = await this.manager.currentBranchName();
        localDefaultBranch = (await this.manager.branchExists(this.configDefaultBranch))
          ? this.configDefaultBranch
          : undefined;
      } catch {
        // Individual probes stay best-effort; blockers below still surface.
      }
    }

    if (remoteConfigured) {
      try {
        remoteDefaultBranch = await this.manager.remoteDefaultBranch(this.remote);
        remoteAccessible = Boolean(remoteDefaultBranch);
        if (remoteDefaultBranch) {
          defaultBranchSource = "git";
        }
      } catch {
        remoteAccessible = false;
      }
    }

    const github = await this.probeGithub(this.options.root);
    if (github.defaultBranch) {
      remoteDefaultBranch = github.defaultBranch;
      defaultBranchSource = "gh";
      // Repo view succeeding is itself the proof that the remote is reachable.
      remoteAccessible = true;
    }

    return this.environment(gitInstalled, gitVersion.stdout.trim() || undefined, {
      isRepository,
      repoRootMatches,
      worktreeClean,
      hasCommits,
      currentBranch,
      remoteConfigured,
      remoteAccessible,
      localDefaultBranch,
      remoteDefaultBranch,
      defaultBranchSource,
      dirtyFiles,
      remoteUrl,
      remoteOwner: remotePolicy.owner ? `${remotePolicy.owner.host}/${remotePolicy.owner.owner}` : undefined,
      remoteAllowed: remotePolicy.allowed,
      remotePolicyReason: remotePolicy.reason,
      changeSummary,
      aheadBehind,
      canCommit,
    }, github);
  }

  async worktreeDiff(
    maxCharacters = 20_000,
    filePath?: string,
  ): Promise<GitWorktreeDiff> {
    const status = await this.status();
    if (!status.isRepository || !status.repoRootMatches) {
      throw new GitActionError("not-a-repository", "当前目录不是 Git 仓库");
    }
    try {
      const normalized = filePath ? normalizeRepositoryRelativePath(filePath) : undefined;
      return await this.manager.worktreeDiff(this.options.root, maxCharacters, undefined, normalized);
    } catch (error) {
      throw this.asGitActionError(error);
    }
  }

  async changes(): Promise<{
    branch?: string;
    files: GitChangeFile[];
    insertions: number;
    deletions: number;
    canCommit: boolean;
    canPush: boolean;
    ahead: number;
    behind: number;
    identityConfigured: boolean;
    identityReason?: string;
  }> {
    const status = await this.status();
    this.requireRepository(status);
    const snapshot = await this.manager.changeSnapshot(this.options.root);
    const identityConfigured = await this.manager.committerIdentityConfigured(this.options.root);
    const canPush = Boolean(
      status.githubAccount?.canPush &&
      status.currentBranch &&
      status.remoteConfigured &&
      status.remoteAccessible &&
      status.remoteAllowed &&
      snapshot.behind === 0,
    );
    return {
      ...(status.currentBranch ? { branch: status.currentBranch } : {}),
      files: snapshot.files,
      insertions: snapshot.insertions,
      deletions: snapshot.deletions,
      canCommit: snapshot.files.length > 0 && identityConfigured && status.hasCommits,
      canPush,
      ahead: snapshot.ahead,
      behind: snapshot.behind,
      identityConfigured,
      ...(identityConfigured
        ? {}
        : { identityReason: "Git 未配置提交者身份：请设置 user.name 与 user.email 后再提交。" }),
    };
  }

  async commitPaths(input: { message: string; paths: string[] }): Promise<{
    commit: string;
    branch?: string;
    files: string[];
  }> {
    const status = await this.status();
    this.requireRepository(status);
    if (!status.hasCommits) {
      throw new GitActionError("no-commits", "仓库还没有提交，请先创建初始提交");
    }
    if (!(await this.manager.committerIdentityConfigured(this.options.root))) {
      throw new GitActionError(
        "no-git-identity",
        "Git 未配置提交者身份：请设置 git config user.name 与 user.email 后重试。",
      );
    }
    const message = input.message.trim();
    if (!message) {
      throw new GitActionError("empty-selection", "提交说明不能为空");
    }
    if (message.length > 2000) {
      throw new GitActionError("empty-selection", "提交说明不能超过 2000 个字符");
    }
    if (input.paths.length === 0) {
      throw new GitActionError("empty-selection", "请至少勾选一个要提交的文件");
    }
    if (input.paths.length > 200) {
      throw new GitActionError("empty-selection", "一次最多提交 200 个文件");
    }
    try {
      const snapshot = await this.manager.changeSnapshot(this.options.root);
      const conflicted = snapshot.files.filter((file) =>
        file.xy.includes("U") || file.xy === "DD" || file.xy === "AA",
      );
      const selected = new Set(input.paths.map((item) => normalizeRepositoryRelativePath(item)));
      if (conflicted.some((file) => selected.has(file.path))) {
        throw new GitActionError("conflict", "勾选的文件里有未解决冲突，请先在外部解决后再提交");
      }
      const result = await this.manager.commitExactPaths(this.options.root, message, input.paths);
      const branch = await this.manager.currentBranchName();
      return {
        commit: result.commit,
        ...(branch ? { branch } : {}),
        files: result.files,
      };
    } catch (error) {
      throw this.asGitActionError(error);
    }
  }

  async pushCurrentBranch(): Promise<{
    remote: string;
    branch: string;
    commit: string;
    setUpstream: boolean;
  }> {
    const status = await this.status();
    this.requireRepository(status);
    if (!status.currentBranch) {
      throw new GitActionError("detached-head", "当前是分离 HEAD，不能推送。请先切到一条分支。");
    }
    if (!status.remoteConfigured) {
      throw new GitActionError("no-remote", "未配置远端，无法推送");
    }
    if (!status.remoteAccessible) {
      throw new GitActionError("remote-unreachable", "远端不可达，无法推送");
    }
    if (status.remoteAllowed === false) {
      throw new GitActionError("remote-not-allowed", status.remotePolicyReason ?? "远端不在企业仓库白名单");
    }
    if (!status.ghInstalled) {
      throw new GitActionError("gh-missing", "未安装 GitHub CLI，无法确认推送身份");
    }
    if (!status.ghAuthenticated) {
      throw new GitActionError("gh-not-authenticated", "还没连接 GitHub。请先点「连接 GitHub」。");
    }
    if (!status.ghRepoAccess) {
      throw new GitActionError("gh-no-repo-access", "已登录，但这个仓库还没有推送权限。可点「补授权」。");
    }
    const { behind } = await this.manager.aheadBehind(this.options.root);
    if (behind > 0) {
      throw new GitActionError(
        "behind-remote",
        `远端有 ${behind} 个尚未拉取的提交，拒绝推送。请先同步（ff-only）或人工处理，不会执行 force-push。`,
      );
    }
    const upstream = await capture(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      this.options.root,
    );
    await this.manager.push(this.options.root, this.remote, status.currentBranch);
    return {
      remote: this.remote,
      branch: status.currentBranch,
      commit: await this.manager.resolveCommit("HEAD"),
      setUpstream: upstream.exitCode !== 0,
    };
  }

  async stashWorktree(message?: string): Promise<{ created: boolean; ref?: string }> {
    const status = await this.status();
    this.requireSyncableExceptClean(status);
    if (status.worktreeClean) {
      throw new GitActionError("clean-worktree", "主工作区已经是干净的，没有可暂存的改动");
    }
    const ref = await this.manager.stashPush(
      this.options.root,
      message?.trim() || "agent-team: stash dirty primary worktree",
    );
    return ref ? { created: true, ref } : { created: false };
  }

  /** Initializes a repository in the project root when it is not one yet. */
  async initializeRepository(): Promise<{ initialized: boolean }> {
    const status = await this.status();
    if (status.isRepository && status.repoRootMatches) {
      return { initialized: false };
    }
    if (!status.gitInstalled) {
      throw new GitActionError("git-missing", "未检测到 Git，请先安装 git 并加入 PATH");
    }
    await this.manager.init(this.configDefaultBranch);
    return { initialized: true };
  }

  /** Creates an empty initial commit for a born-but-empty repository. */
  async createInitialCommit(): Promise<string> {
    const status = await this.status();
    if (!status.gitInstalled) {
      throw new GitActionError("git-missing", "未检测到 Git，请先安装 git 并加入 PATH");
    }
    if (!status.isRepository || !status.repoRootMatches) {
      throw new GitActionError("not-a-repository", "当前目录不是 Git 仓库，请先初始化");
    }
    return await this.manager.commitAllowEmpty("chore: initial empty commit");
  }

  async branches(scope: BranchListScope = "all"): Promise<BranchInfo[]> {
    const status = await this.status();
    if (!status.isRepository || !status.repoRootMatches) {
      return [];
    }
    const defaultBranch = status.remoteDefaultBranch ?? status.localDefaultBranch ?? this.configDefaultBranch;
    const currentBranch = status.currentBranch;
    const branches: BranchInfo[] = [];

    if (scope === "local" || scope === "all") {
      const result = await capture(
        "git",
        ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"],
        this.options.root,
      );
      if (result.exitCode === 0) {
        for (const entry of result.stdout.split("\n")) {
          const [name, commit] = entry.split("\0");
          if (!name || !commit) continue;
          branches.push({
            name,
            kind: "local",
            commit,
            isDefault: name === defaultBranch,
            isCurrent: name === currentBranch,
            temporary: isTemporaryAgentBranch(name, currentBranch, defaultBranch),
          });
        }
      }
    }

    if (scope === "remote" || scope === "all") {
      if (status.remoteConfigured) {
        try {
          const remoteBranches = await this.manager.remoteBranches(this.remote);
          for (const [name, commit] of remoteBranches) {
            branches.push({
              name,
              kind: "remote",
              commit,
              isDefault: name === defaultBranch,
              isCurrent: false,
              temporary: isTemporaryAgentBranch(name, undefined, defaultBranch),
            });
          }
        } catch {
          // Remote read failures surface in /git/status blockers.
        }
      }
    }

    return branches;
  }

  /** ff-only sync of one branch (defaults to the remote default branch). */
  async sync(request: { branch?: string | undefined } = {}): Promise<BranchSyncResult> {
    const status = await this.status();
    this.requireSyncable(status);
    const branch = request.branch ?? status.remoteDefaultBranch ?? this.configDefaultBranch;
    await this.assertName(branch);
    const previousCommit = (await this.manager.branchExists(branch))
      ? await this.manager.resolveCommit(`refs/heads/${branch}`)
      : undefined;

    await this.manager.fetch(this.remote, branch);
    const newCommit = await this.manager.resolveCommit("FETCH_HEAD");

    if (!previousCommit) {
      await this.manager.createBranch(branch, newCommit);
      return { branch, previousCommit: undefined, newCommit, changed: true };
    }
    if (previousCommit === newCommit) {
      return { branch, previousCommit, newCommit, changed: false };
    }
    if (!(await this.manager.isAncestor(previousCommit, newCommit))) {
      throw new GitActionError(
        "non-fast-forward",
        `远端 ${this.remote}/${branch} 不是本地的快进提交（本地 ${previousCommit.slice(0, 8)}，远端 ${newCommit.slice(0, 8)}），拒绝同步。请人工确认后处理。`,
      );
    }
    const current = await this.manager.currentBranchName();
    if (current === branch) {
      // The checked-out branch follows the worktree content in one ff merge.
      await this.manager.mergeFastForwardOnly(this.options.root, newCommit);
    } else {
      await this.manager.updateRefFastForward(branch, newCommit, previousCommit);
    }
    return { branch, previousCommit, newCommit, changed: true };
  }

  async create(request: {
    name: string;
    baseBranch?: string | undefined;
    syncFirst?: boolean | undefined;
  }): Promise<BranchInfo> {
    const name = request.name.trim();
    if (!name || name.startsWith("agent-team/")) {
      throw new GitActionError(
        "invalid-name",
        "自定义分支名不能为空，且不允许使用保留前缀 agent-team/",
      );
    }
    const status = await this.status();
    this.requireSyncable(status);
    await this.assertName(name);
    if ((await this.manager.branchExists(name)) || (await this.remoteBranchExists(name))) {
      throw new GitActionError(
        "branch-exists",
        `分支 '${name}' 已存在于本地或远端，请更换名称${suggestedSuffix(name) ? `（建议 ${suggestedSuffix(name)}）` : ""}`,
      );
    }

    const baseBranch = request.baseBranch?.trim() || (status.remoteDefaultBranch ?? this.configDefaultBranch);
    await this.assertName(baseBranch);
    let baseCommit: string;
    if (request.syncFirst && baseBranch === (status.remoteDefaultBranch ?? this.configDefaultBranch)) {
      baseCommit = (await this.sync({ branch: baseBranch })).newCommit;
    } else {
      baseCommit = await this.resolveBranchCommit(baseBranch);
    }
    await this.manager.createBranch(name, baseCommit);
    return {
      name,
      kind: "local",
      commit: baseCommit,
      isDefault: false,
      isCurrent: false,
      temporary: false,
    };
  }

  async deleteTemporaryBranches(): Promise<{ deleted: string[]; skipped: string[] }> {
    const status = await this.status();
    this.requireSyncable(status);
    const current = status.currentBranch;
    const defaultBranch = status.remoteDefaultBranch ?? status.localDefaultBranch ?? this.configDefaultBranch;
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const branch of await this.branches("local")) {
      if (!branch.temporary) continue;
      if (branch.isCurrent || branch.name === current || branch.name === defaultBranch) {
        skipped.push(branch.name);
        continue;
      }
      try {
        await this.manager.deleteBranch(branch.name);
        deleted.push(branch.name);
      } catch {
        skipped.push(branch.name);
      }
    }
    return { deleted, skipped };
  }

  async resolveBaseCommit(branch: string, options: { syncDefaultFirst?: boolean } = {}): Promise<string> {
    const status = await this.status();
    this.requireSyncable(status);
    await this.assertName(branch);
    if (options.syncDefaultFirst && branch === (status.remoteDefaultBranch ?? this.configDefaultBranch)) {
      return (await this.sync({ branch })).newCommit;
    }
    return await this.resolveBranchCommit(branch);
  }

  /** Runner-facing preflight: the head branch must be valid and not exist yet. */
  async assertHeadBranchAvailable(name: string): Promise<void> {
    if (name.startsWith("agent-team/")) {
      throw new GitActionError(
        "invalid-name",
        "用户自定义工作分支不允许使用保留前缀 agent-team/",
      );
    }
    await this.assertName(name);
    if (await this.manager.branchExists(name)) {
      throw new GitActionError("branch-exists", `工作分支 '${name}' 已存在，请更换名称后重试`);
    }
    if (await this.remoteBranchExists(name)) {
      throw new GitActionError("branch-exists", `工作分支 '${name}' 已存在于远端，请更换名称后重试`);
    }
  }

  private async assertName(name: string): Promise<void> {
    try {
      await this.manager.assertValidBranchName(name);
    } catch {
      throw new GitActionError("invalid-name", `分支名 '${name}' 不是合法的 Git 分支名`);
    }
  }

  private async resolveBranchCommit(branch: string): Promise<string> {
    try {
      return await this.manager.resolveCommit(`refs/heads/${branch}`);
    } catch {
      const remoteRef = `refs/remotes/${this.remote}/${branch}`;
      try {
        return await this.manager.resolveCommit(remoteRef);
      } catch {
        throw new GitActionError(
          "not-a-repository",
          `找不到基准分支 '${branch}'：本地与 ${this.remote} 远端都不存在该分支。请先同步远端或选择其他分支。`,
        );
      }
    }
  }

  private async remoteBranchExists(name: string): Promise<boolean> {
    try {
      return (await this.manager.remoteBranches(this.remote)).has(name);
    } catch {
      return false;
    }
  }

  private asGitActionError(error: unknown): GitActionError {
    if (error instanceof GitActionError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (/path|escape|\.\.|unsafe/i.test(message)) {
      return new GitActionError("invalid-name", "文件路径不合法，已拒绝。");
    }
    return new GitActionError("empty-selection", message);
  }

  private requireRepository(status: GitEnvironmentStatus): void {
    if (!status.gitInstalled) {
      throw new GitActionError("git-missing", "未检测到 Git，请先安装 git 并加入 PATH");
    }
    if (!status.isRepository) {
      throw new GitActionError(
        "not-a-repository",
        "当前项目目录不是 Git 仓库。请先在项目根目录执行 git init，或使用界面中的初始化引导。",
      );
    }
    if (!status.repoRootMatches) {
      throw new GitActionError("root-mismatch", "配置文件根目录必须与 Git 仓库顶层目录一致");
    }
  }

  private requireSyncableExceptClean(status: GitEnvironmentStatus): void {
    this.requireRepository(status);
  }

  private requireSyncable(status: GitEnvironmentStatus): void {
    this.requireRepository(status);
    if (!status.worktreeClean) {
      const files = status.dirtyFiles.slice(0, 6).map((file) => file.path).join("、");
      throw new GitActionError(
        "dirty-worktree",
        files
          ? `主工作区有未提交改动（${files}${status.dirtyFiles.length > 6 ? "…" : ""}）。请先提交、暂存或查看改动后再同步/开跑。`
          : "主工作区存在未提交改动，请先提交或暂存后再操作",
      );
    }
  }

  private environment(
    gitInstalled: boolean,
    gitVersion: string | undefined,
    probe: {
      isRepository: boolean;
      repoRootMatches: boolean;
      worktreeClean: boolean;
      hasCommits: boolean;
      currentBranch?: string | undefined;
      remoteConfigured: boolean;
      remoteAccessible: boolean;
      localDefaultBranch?: string | undefined;
      remoteDefaultBranch?: string | undefined;
      defaultBranchSource: GitEnvironmentStatus["defaultBranchSource"];
      dirtyFiles?: DirtyWorktreeFile[];
      remoteUrl?: string | undefined;
      remoteOwner?: string | undefined;
      remoteAllowed?: boolean;
      remotePolicyReason?: string | undefined;
      changeSummary?: GitEnvironmentStatus["changeSummary"];
      aheadBehind?: GitEnvironmentStatus["aheadBehind"];
      canCommit?: boolean;
    },
    github: GithubProbeResult,
  ): GitEnvironmentStatus {
    const blockers: GitBlocker[] = [];
    if (!gitInstalled) blockers.push("git-missing");
    else {
      if (!probe.isRepository) blockers.push("not-a-repository");
      else if (!probe.repoRootMatches) blockers.push("root-mismatch");
      else {
        if (!probe.worktreeClean) blockers.push("dirty-worktree");
        if (!probe.hasCommits) blockers.push("no-commits");
      }
      if (!probe.remoteConfigured) blockers.push("no-remote");
      else if (!probe.remoteAccessible) blockers.push("remote-unreachable");
      if (probe.remoteAllowed === false) blockers.push("remote-not-allowed");
      if (!github.installed) blockers.push("gh-missing");
      else if (!github.authenticated) blockers.push("gh-not-authenticated");
      else if (!github.repoAccess) blockers.push("gh-no-repo-access");
    }
    const remoteAccessible = probe.remoteConfigured && probe.remoteAccessible;
    const dirtyFiles = probe.dirtyFiles ?? [];
    const dirtyReason = !probe.worktreeClean && dirtyFiles.length > 0
      ? dirtyWorktreeReason(dirtyFiles)
      : undefined;
    const githubAccount = accountFromProbe({
      host: github.host ?? githubHostFromRemoteUrl(probe.remoteUrl),
      installed: github.installed,
      authenticated: github.authenticated,
      repoAccess: github.repoAccess,
      ...(github.login ? { login: github.login } : {}),
      ...(github.scopes ? { scopes: github.scopes } : {}),
      ...(github.tokenSource ? { tokenSource: github.tokenSource } : {}),
      ...(github.gitProtocol ? { gitProtocol: github.gitProtocol } : {}),
      ...(github.repoNameWithOwner ? { repoNameWithOwner: github.repoNameWithOwner } : {}),
      remoteAllowed: probe.remoteAllowed !== false,
      remoteAccessible,
      worktreeClean: probe.worktreeClean,
      canPublishBase:
        gitInstalled &&
        probe.isRepository &&
        probe.repoRootMatches &&
        probe.remoteConfigured &&
        remoteAccessible,
    });
    const canPublish =
      githubAccount.canPublish &&
      probe.worktreeClean &&
      github.installed &&
      github.authenticated &&
      github.repoAccess;
    const canPushBranch = Boolean(
      githubAccount.canPush && probe.currentBranch && (probe.aheadBehind?.behind ?? 0) === 0,
    );
    return {
      gitInstalled,
      ...(gitVersion ? { gitVersion } : {}),
      isRepository: probe.isRepository,
      repoRootMatches: probe.repoRootMatches,
      worktreeClean: probe.worktreeClean,
      hasCommits: probe.hasCommits,
      ...(probe.currentBranch ? { currentBranch: probe.currentBranch } : {}),
      remote: this.remote,
      remoteConfigured: probe.remoteConfigured,
      remoteAccessible,
      ...(probe.localDefaultBranch ? { localDefaultBranch: probe.localDefaultBranch } : {}),
      ...(probe.remoteDefaultBranch ? { remoteDefaultBranch: probe.remoteDefaultBranch } : {}),
      defaultBranchSource: probe.defaultBranchSource,
      ghInstalled: github.installed,
      ghAuthenticated: github.authenticated,
      ghRepoAccess: github.repoAccess,
      canSync: gitInstalled && probe.isRepository && probe.repoRootMatches && probe.worktreeClean && probe.remoteConfigured && remoteAccessible,
      canPublish,
      blockers,
      dirtyFiles,
      ...(dirtyReason ? { dirtyReason } : {}),
      ...(probe.remoteUrl ? { remoteUrl: probe.remoteUrl } : {}),
      ...(probe.remoteOwner ? { remoteOwner: probe.remoteOwner } : {}),
      remoteAllowed: probe.remoteAllowed !== false,
      ...(probe.remotePolicyReason ? { remotePolicyReason: probe.remotePolicyReason } : {}),
      githubAccount,
      ...(probe.changeSummary ? { changeSummary: probe.changeSummary } : {}),
      canCommit: Boolean(probe.canCommit),
      canPushBranch,
      ...(probe.aheadBehind ? { aheadBehind: probe.aheadBehind } : {}),
    };
  }

  assertRemoteAllowed(status = undefined as GitEnvironmentStatus | undefined): void {
    const current = status;
    if (current && current.remoteAllowed === false) {
      throw new GitActionError("remote-not-allowed", current.remotePolicyReason ?? "远端不在企业仓库白名单");
    }
  }
}

/** Goal-driven branch name suggestion, collision-safe against known names. */
export function suggestBranchName(
  goal: string,
  prefix = "feature",
  existing: Iterable<string> = [],
): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "goal";
  const known = new Set(existing);
  let candidate = `${prefix}/${slug}`;
  for (let attempt = 2; known.has(candidate); attempt += 1) {
    candidate = `${prefix}/${slug}-${attempt}`;
  }
  return candidate;
}

function suggestedSuffix(name: string): string {
  const match = name.match(/^(.*?)(?:-(\d+))?$/);
  const base = match?.[1] || name;
  const next = Number(match?.[2] ?? 1) + 1;
  return `${base}-${next}`;
}

export function isTemporaryAgentBranch(
  name: string,
  currentBranch?: string,
  defaultBranch?: string,
): boolean {
  if (name === currentBranch || name === defaultBranch || name === "main" || name === "master") {
    return false;
  }
  return name === "agent-team" || name.startsWith("agent-team/");
}

function dirtyWorktreeReason(files: DirtyWorktreeFile[]): string {
  const agent = files.filter((file) => file.origin === "agent").length;
  const user = files.length - agent;
  if (agent > 0 && user > 0) {
    return `主工作区有 ${user} 个未提交的本地改动，另有 ${agent} 个像是 Agent 残留路径。先看改动，再选择提交或暂存。`;
  }
  if (agent > 0) {
    return `主工作区有 ${agent} 个像是 Agent 残留的未提交路径。可查看改动后暂存，以免挡住同步和开跑。`;
  }
  return `主工作区有 ${user} 个未提交的本地改动。同步远端、新建分支和启动运行前需要先处理。`;
}

function emptyEnvironmentProbe(): {
  isRepository: boolean;
  repoRootMatches: boolean;
  worktreeClean: boolean;
  hasCommits: boolean;
  currentBranch?: string | undefined;
  remoteConfigured: boolean;
  remoteAccessible: boolean;
  localDefaultBranch?: string | undefined;
  remoteDefaultBranch?: string | undefined;
  defaultBranchSource: GitEnvironmentStatus["defaultBranchSource"];
} {
  return {
    isRepository: false,
    repoRootMatches: false,
    worktreeClean: false,
    hasCommits: false,
    remoteConfigured: false,
    remoteAccessible: false,
    defaultBranchSource: "config",
  };
}

async function capture(
  command: string,
  args: string[],
  cwd: string,
): Promise<ProcessResult> {
  try {
    return await runProcess({ command, args, cwd, timeoutMs: 120_000 });
  } catch {
    return {
      command,
      args,
      exitCode: 127,
      stdout: "",
      stderr: `${command} not found`,
      durationMs: 0,
      timedOut: false,
      signal: null,
    };
  }
}

async function exitsZero(command: string, args: string[], cwd: string): Promise<boolean> {
  return (await capture(command, args, cwd)).exitCode === 0;
}
