import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathMatchesOwnedPath } from "../domain/owned-paths.js";
import { runProcess, type ProcessResult } from "../process/run.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface GitDiffEvidence {
  content: string;
  changedFiles: string[];
  truncated: boolean;
}

export interface GitChangeFile {
  path: string;
  originalPath?: string;
  xy: string;
  status: string;
  origin: "user" | "agent";
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface GitChangeSnapshot {
  files: GitChangeFile[];
  insertions: number;
  deletions: number;
  ahead: number;
  behind: number;
}

export interface GitWorktreeDiff {
  content: string;
  truncated: boolean;
  binary?: boolean;
}

const UNTRACKED_PREVIEW_BYTES = 200_000;

/** Stable structured codes for exact-path primary-worktree mutations. */
export type GitManagerErrorCode =
  | "GIT_INVALID_AUTHORIZATION"
  | "GIT_HEAD_DRIFT"
  | "GIT_WORKTREE_CONTAMINATED"
  | "GIT_UNSAFE_PATH"
  | "GIT_TARGET_NOT_TRACKED"
  | "GIT_OPERATION_FAILED";

export class GitManagerError extends Error {
  readonly code: GitManagerErrorCode;

  constructor(code: GitManagerErrorCode, message: string) {
    super(message);
    this.name = "GitManagerError";
    this.code = code;
  }
}

/**
 * Pre-mutation authorization for committing exactly one already-tracked
 * repository-relative file in the primary worktree. Captures HEAD and proof
 * that the worktree (including the target) was clean before the caller's
 * mutation.
 */
export interface ExactTrackedFileCommitAuthorization {
  readonly kind: "exact-tracked-file-commit";
  readonly root: string;
  readonly head: string;
  readonly repositoryRelativePath: string;
  readonly issuedAtMs: number;
}

export interface ExactTrackedFileCommitResult {
  readonly commit: string;
  readonly path: string;
  readonly previousHead: string;
}

export class GitManager {
  readonly #issuedExactFileAuthorizations = new WeakSet<object>();

  constructor(
    readonly root: string,
    readonly worktreesRoot: string,
  ) {}

  async assertReady(signal?: AbortSignal): Promise<void> {
    const topLevel = await this.git(["rev-parse", "--show-toplevel"], this.root, 120_000, undefined, signal);
    const [gitRoot, configuredRoot] = await Promise.all([
      realpath(topLevel.stdout.trim()),
      realpath(this.root),
    ]);
    if (gitRoot !== configuredRoot) {
      throw new Error(`Configuration root '${this.root}' must be the Git repository root`);
    }
    if (!(await this.isClean(this.root, signal))) {
      throw new Error("The primary Git worktree must be clean before starting a run");
    }
  }

  async resolveCommit(ref: string): Promise<string> {
    return (await this.git(["rev-parse", ref], this.root)).stdout.trim();
  }

  async createWorktree(
    branch: string,
    startPoint: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<WorktreeInfo> {
    this.assertManagedPath(directory);
    await mkdir(path.dirname(directory), { recursive: true });
    await this.git(["worktree", "add", "-b", branch, directory, startPoint], this.root, 120_000, undefined, signal);
    return { path: directory, branch };
  }

  async removeWorktree(directory: string, signal?: AbortSignal): Promise<void> {
    this.assertManagedPath(directory);
    await this.git(["worktree", "remove", "--force", directory], this.root, 120_000, undefined, signal);
  }

  /** Drop stale worktree registrations whose directories are already gone. */
  async pruneWorktrees(signal?: AbortSignal): Promise<void> {
    await this.git(["worktree", "prune"], this.root, 120_000, undefined, signal);
  }

  async listBranches(pattern: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.git(
      ["branch", "--list", "--format=%(refname:short)", pattern],
      this.root,
      120_000,
      undefined,
      signal,
    );
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async deleteBranch(branch: string, signal?: AbortSignal): Promise<void> {
    await this.git(["branch", "-D", branch], this.root, 120_000, undefined, signal);
  }

  async stage(directory: string, signal?: AbortSignal): Promise<void> {
    await this.git(["add", "--all"], directory, 120_000, undefined, signal);
  }

  async changedFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.git(
      ["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB", "-z"],
      directory,
      120_000,
      undefined,
      signal,
    );
    return parseNulFields(result.stdout);
  }

  async stagedDiff(directory: string, maxCharacters = 160_000, signal?: AbortSignal): Promise<string> {
    const result = await this.git(
      ["diff", "--cached", "--no-ext-diff", "--unified=60"],
      directory,
      120_000,
      undefined,
      signal,
    );
    if (result.stdout.length <= maxCharacters) {
      return result.stdout;
    }
    return `${result.stdout.slice(0, maxCharacters)}\n\n[diff truncated at ${maxCharacters} characters]`;
  }

  assertOwnedPaths(files: string[], patterns: string[]): void {
    const violations = files.filter(
      (file) => !patterns.some((pattern) => pathMatchesOwnedPath(file, pattern)),
    );
    if (violations.length > 0) {
      throw new Error(`Changed files outside task ownership: ${violations.join(", ")}`);
    }
  }

  async commit(directory: string, message: string, signal?: AbortSignal): Promise<string> {
    await this.git(["commit", "-m", message], directory, 120_000, undefined, signal);
    return (await this.git(["rev-parse", "HEAD"], directory, 120_000, undefined, signal)).stdout.trim();
  }

  /**
   * Authorize a later exact-path forward commit in the primary worktree.
   *
   * Requires:
   * - `root` is the canonical primary repository
   * - the worktree is completely clean (no staged/unstaged/untracked changes)
   * - `repositoryRelativePath` is a normalized, repository-relative tracked path
   * - the target is a regular non-symlink file already in HEAD
   */
  async authorizeExactTrackedFileCommit(
    repositoryRelativePath: string,
  ): Promise<ExactTrackedFileCommitAuthorization> {
    const root = await this.resolveCanonicalPrimaryRoot();
    const normalizedPath = normalizeRepositoryRelativePath(repositoryRelativePath);
    await this.assertTrackedRegularFile(root, normalizedPath);

    if (!(await this.isClean(root))) {
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        "Primary worktree must be clean before authorizing an exact-file commit",
      );
    }

    const head = (await this.git(["rev-parse", "HEAD"], root)).stdout.trim();
    assertGitObjectId(head);

    const authorization = Object.freeze({
      kind: "exact-tracked-file-commit" as const,
      root,
      head,
      repositoryRelativePath: normalizedPath,
      issuedAtMs: Date.now(),
    });
    this.#issuedExactFileAuthorizations.add(authorization);
    return authorization;
  }

  /** Read-only proof that a repository-relative path is a regular file tracked by HEAD. */
  async verifyTrackedRegularFile(repositoryRelativePath: string): Promise<string> {
    const root = await this.resolveCanonicalPrimaryRoot();
    const normalizedPath = normalizeRepositoryRelativePath(repositoryRelativePath);
    await this.assertTrackedRegularFile(root, normalizedPath);
    return normalizedPath;
  }

  /**
   * Commit exactly one already-authorized tracked file after the caller's mutation.
   *
   * Stages only that path (argv + `--`), rejects any staged/unstaged change
   * outside it, verifies the resulting index contains exactly that path, and
   * creates a normal forward commit (never reset/checkout/force/shell/remote).
   */
  async commitExactTrackedFile(
    authorization: ExactTrackedFileCommitAuthorization,
    message: string,
  ): Promise<ExactTrackedFileCommitResult> {
    this.assertValidAuthorization(authorization);
    if (typeof message !== "string" || !message.trim()) {
      throw new GitManagerError("GIT_INVALID_AUTHORIZATION", "Commit message is required");
    }
    this.#issuedExactFileAuthorizations.delete(authorization);

    const root = await this.resolveCanonicalPrimaryRoot();
    if (root !== authorization.root) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization is bound to a different repository root",
      );
    }

    const normalizedPath = normalizeRepositoryRelativePath(authorization.repositoryRelativePath);
    if (normalizedPath !== authorization.repositoryRelativePath) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization path is not normalized",
      );
    }

    const currentHead = (await this.git(["rev-parse", "HEAD"], root)).stdout.trim();
    if (currentHead !== authorization.head) {
      throw new GitManagerError(
        "GIT_HEAD_DRIFT",
        `Primary HEAD drifted before exact-file commit: expected ${authorization.head}, found ${currentHead}`,
      );
    }

    await this.assertTrackedRegularFile(root, normalizedPath);

    const statusBeforeStage = await this.porcelainStatus(root);
    const outsideBefore = statusBeforeStage.filter((entry) => entry.path !== normalizedPath);
    if (outsideBefore.length > 0) {
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        `Refusing exact-file commit with changes outside '${normalizedPath}': ${formatStatusEntries(outsideBefore)}`,
      );
    }

    const targetStatus = statusBeforeStage.find((entry) => entry.path === normalizedPath);
    if (!targetStatus) {
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        `Exact-file target '${normalizedPath}' has no local changes to commit`,
      );
    }
    if (targetStatus.xy === "??") {
      throw new GitManagerError(
        "GIT_TARGET_NOT_TRACKED",
        `Exact-file target '${normalizedPath}' is untracked; only already-tracked files may be committed`,
      );
    }
    if (targetStatus.xy.includes("U") || targetStatus.xy === "AA" || targetStatus.xy === "DD") {
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        `Exact-file target '${normalizedPath}' has an unresolved merge state (${targetStatus.xy})`,
      );
    }

    // Stage only the exact path using argv and `--` (never shell, never broad add).
    await this.git(["add", "--", normalizedPath], root);

    const staged = await this.changedFiles(root);
    if (staged.length !== 1 || staged[0] !== normalizedPath) {
      // Leave the index as-is only if we can prove contamination; never attempt
      // reset/checkout. Reject so the controller can inspect the worktree.
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        `Exact-file stage produced unexpected index contents: ${staged.join(", ") || "(empty)"}`,
      );
    }

    const statusAfterStage = await this.porcelainStatus(root);
    const outsideAfter = statusAfterStage.filter((entry) => entry.path !== normalizedPath);
    if (outsideAfter.length > 0) {
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        `Refusing exact-file commit with residual changes outside '${normalizedPath}': ${formatStatusEntries(outsideAfter)}`,
      );
    }

    // Freeze the verified index into a tree, then revalidate the tree itself.
    // `commit-tree` bypasses hooks that could mutate the index after validation;
    // `update-ref <new> <expected-old>` advances the branch only if HEAD stayed put.
    const tree = (await this.git(["write-tree"], root)).stdout.trim();
    assertGitObjectId(tree);
    const frozenChangedPaths = parseNulFields(
      (
        await this.git(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", authorization.head, tree],
          root,
        )
      ).stdout,
    );
    if (frozenChangedPaths.length !== 1 || frozenChangedPaths[0] !== normalizedPath) {
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        `Frozen exact-file tree contains unexpected paths: ${frozenChangedPaths.join(", ") || "(empty)"}`,
      );
    }

    const branchRef = (
      await this.git(["symbolic-ref", "-q", "HEAD"], root).catch((error: unknown) => {
        throw new GitManagerError(
          "GIT_OPERATION_FAILED",
          `Exact-file commit requires an attached branch${
            error instanceof Error ? `: ${error.message}` : ""
          }`,
        );
      })
    ).stdout.trim();
    if (!branchRef.startsWith("refs/heads/")) {
      throw new GitManagerError(
        "GIT_OPERATION_FAILED",
        `Exact-file commit requires a local branch, found '${branchRef}'`,
      );
    }

    const commit = (
      await this.git(
        ["commit-tree", tree, "-p", authorization.head],
        root,
        120_000,
        `${message.trim()}\n`,
      )
    ).stdout.trim();
    assertGitObjectId(commit);
    await this.git(
      ["update-ref", "-m", message.trim(), branchRef, commit, authorization.head],
      root,
    ).catch((error: unknown) => {
      throw new GitManagerError(
        "GIT_HEAD_DRIFT",
        `Primary HEAD drifted before exact-file ref update${
          error instanceof Error ? `: ${error.message}` : ""
        }`,
      );
    });
    if (commit === authorization.head) {
      throw new GitManagerError(
        "GIT_OPERATION_FAILED",
        "Exact-file commit did not advance HEAD",
      );
    }

    return Object.freeze({
      commit,
      path: normalizedPath,
      previousHead: authorization.head,
    });
  }

  async merge(
    integrationDirectory: string,
    branch: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.git(["merge", "--no-ff", branch, "-m", message], integrationDirectory, 120_000, undefined, signal);
    return (await this.git(["rev-parse", "HEAD"], integrationDirectory, 120_000, undefined, signal)).stdout.trim();
  }

  async diffSummary(directory: string, baseRef: string): Promise<string> {
    return (await this.git(["diff", "--stat", `${baseRef}...HEAD`], directory)).stdout.trim();
  }

  async diffBetween(
    baseCommit: string,
    targetCommit: string,
    maxCharacters = 300_000,
  ): Promise<GitDiffEvidence> {
    assertGitObjectId(baseCommit);
    assertGitObjectId(targetCommit);
    const range = `${baseCommit}...${targetCommit}`;
    const [diff, files] = await Promise.all([
      this.git(["diff", "--no-ext-diff", "--unified=30", range], this.root),
      this.git(["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z", range], this.root),
    ]);
    const truncated = diff.stdout.length > maxCharacters;
    return {
      content: truncated
        ? `${diff.stdout.slice(0, maxCharacters)}\n\n[diff truncated at ${maxCharacters} characters]`
        : diff.stdout,
      changedFiles: parseNulFields(files.stdout),
      truncated,
    };
  }

  async currentCommit(directory: string, signal?: AbortSignal): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], directory, 120_000, undefined, signal)).stdout.trim();
  }

  /**
   * First-parent commits reachable from `toRef` but not from `fromExclusive`
   * (`rev-list --first-parent from..to`): the commits by which the branch
   * itself advanced, excluding commits pulled in through merged branches.
   */
  async commitsBetween(
    directory: string,
    fromExclusive: string,
    toRef: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const result = await this.git(
      ["rev-list", "--first-parent", `${fromExclusive}..${toRef}`],
      directory,
      120_000,
      undefined,
      signal,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Map of commit hash -> subject for first-parent commits after
   * `fromExclusive` up to `toRef`. Used to recognize the deterministic merge
   * commits (`merge: <taskId> <title>`) after a crash between a task merge
   * and its state save.
   */
  async commitSubjects(
    directory: string,
    fromExclusive: string,
    toRef: string,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const result = await this.git(
      ["log", "--first-parent", "--format=%H%x00%s", `${fromExclusive}..${toRef}`],
      directory,
      120_000,
      undefined,
      signal,
    );
    const subjects = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const separator = line.indexOf("\0");
      if (separator <= 0) {
        continue;
      }
      subjects.set(line.slice(0, separator), line.slice(separator + 1));
    }
    return subjects;
  }

  async dirtyFiles(
    directory: string,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; status: string; origin: "user" | "agent" }>> {
    const snapshot = await this.changeSnapshot(directory, signal);
    return snapshot.files.map((file) => ({
      path: file.path,
      status: file.status,
      origin: file.origin,
    }));
  }

  async changeSnapshot(directory: string, signal?: AbortSignal): Promise<GitChangeSnapshot> {
    const entries = await this.porcelainStatus(directory, signal);
    const numstat = await this.numstatAgainstHead(directory, signal);
    const files: GitChangeFile[] = [];
    for (const entry of entries) {
      const untracked = entry.xy.includes("?");
      const staged = /[ACDMR]/.test(entry.xy[0] ?? " ");
      const unstaged = /[ACDMR?]/.test(entry.xy[1] ?? " ") || (entry.xy[1] !== undefined && entry.xy[1] !== " " && !untracked);
      const stats = numstat.get(entry.path) ?? (untracked
        ? await this.untrackedStat(directory, entry.path)
        : { insertions: 0, deletions: 0, binary: false });
      files.push({
        path: entry.path,
        ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
        xy: entry.xy,
        status: porcelainLabel(entry.xy),
        origin: changeOrigin(entry.path),
        staged,
        unstaged: untracked || unstaged,
        untracked,
        insertions: stats.insertions,
        deletions: stats.deletions,
        binary: stats.binary,
      });
    }
    const { ahead, behind } = await this.aheadBehind(directory, signal);
    return {
      files,
      insertions: files.reduce((sum, file) => sum + file.insertions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      ahead,
      behind,
    };
  }

  async worktreeDiff(
    directory: string,
    maxCharacters = 20_000,
    signal?: AbortSignal,
    filePath?: string,
  ): Promise<GitWorktreeDiff> {
    if (filePath) {
      return await this.pathDiff(directory, filePath, maxCharacters, signal);
    }
    const result = await this.git(
      ["diff", "--no-ext-diff", "--unified=40", "HEAD"],
      directory,
      120_000,
      undefined,
      signal,
    );
    const untracked = await this.git(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      directory,
      120_000,
      undefined,
      signal,
    );
    const extras = parseNulFields(untracked.stdout)
      .slice(0, 40)
      .map((file) => `?? ${file}`)
      .join("\n");
    const content = [result.stdout.trim(), extras].filter(Boolean).join("\n\n");
    const truncated = content.length > maxCharacters;
    return {
      content: truncated ? `${content.slice(0, maxCharacters)}\n\n[diff truncated]` : content,
      truncated,
    };
  }

  async commitExactPaths(
    directory: string,
    message: string,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<{ commit: string; files: string[] }> {
    if (typeof message !== "string" || !message.trim()) {
      throw new GitManagerError("GIT_INVALID_AUTHORIZATION", "Commit message is required");
    }
    const normalized = uniqueNormalizedPaths(paths);
    if (normalized.length === 0) {
      throw new GitManagerError("GIT_UNSAFE_PATH", "至少勾选一个要提交的文件");
    }
    const dirty = new Set((await this.porcelainStatus(directory, signal)).map((entry) => entry.path));
    const missing = normalized.filter((file) => !dirty.has(file));
    if (missing.length > 0) {
      throw new GitManagerError(
        "GIT_TARGET_NOT_TRACKED",
        `这些路径当前没有未提交改动：${missing.join("、")}`,
      );
    }
    await this.git(["add", "--", ...normalized], directory, 120_000, undefined, signal);
    const staged = await this.changedFiles(directory, signal);
    const unexpected = staged.filter((file) => !normalized.includes(file));
    if (unexpected.length > 0) {
      throw new GitManagerError(
        "GIT_WORKTREE_CONTAMINATED",
        `暂存区出现未勾选路径，已拒绝提交：${unexpected.join("、")}`,
      );
    }
    if (staged.length === 0) {
      throw new GitManagerError("GIT_OPERATION_FAILED", "勾选的文件没有可提交的改动");
    }
    const commit = await this.commit(directory, message.trim(), signal);
    return { commit, files: staged };
  }

  async aheadBehind(
    directory: string,
    signal?: AbortSignal,
  ): Promise<{ ahead: number; behind: number }> {
    const result = await this.git(
      ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      directory,
      120_000,
      undefined,
      signal,
      [0, 128],
    );
    if (result.exitCode !== 0) {
      return { ahead: 0, behind: 0 };
    }
    const match = result.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) return { ahead: 0, behind: 0 };
    return { behind: Number(match[1]), ahead: Number(match[2]) };
  }

  async committerIdentityConfigured(directory: string, signal?: AbortSignal): Promise<boolean> {
    const name = await this.git(["config", "--get", "user.name"], directory, 30_000, undefined, signal, [0, 1]);
    const email = await this.git(["config", "--get", "user.email"], directory, 30_000, undefined, signal, [0, 1]);
    return name.exitCode === 0 && Boolean(name.stdout.trim())
      && email.exitCode === 0 && Boolean(email.stdout.trim());
  }

  async stashPush(directory: string, message: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.git(
      ["stash", "push", "--include-untracked", "-m", message],
      directory,
      120_000,
      undefined,
      signal,
    );
    const match = result.stdout.match(/Saved working directory and index state (On .+)/);
    return match?.[1] ?? (result.stdout.includes("No local changes to save") ? undefined : result.stdout.trim() || "stash");
  }

  async isClean(directory: string, signal?: AbortSignal): Promise<boolean> {
    const status = await this.git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      directory,
      120_000,
      undefined,
      signal,
    );
    return status.stdout.length === 0;
  }

  async push(directory: string, remote: string, branch: string): Promise<void> {
    await this.git(["push", "--set-upstream", remote, branch], directory, 300_000);
  }

  async fetch(remote: string, ref: string, signal?: AbortSignal): Promise<void> {
    await this.git(["fetch", remote, ref], this.root, 300_000, undefined, signal);
  }

  /** Initializes a Git repository with the requested initial branch name. */
  async init(branch: string, signal?: AbortSignal): Promise<void> {
    await this.git(["init", "-b", branch], this.root, 120_000, undefined, signal);
  }

  /** Creates an empty initial commit so an unborn branch becomes runnable. */
  async commitAllowEmpty(message: string, signal?: AbortSignal): Promise<string> {
    await this.git(
      ["commit", "--allow-empty", "-m", message],
      this.root,
      120_000,
      undefined,
      signal,
    );
    return await this.resolveCommit("HEAD");
  }

  /** `git merge-base --is-ancestor`; true when ancestor is reachable from descendant. */
  async isAncestor(ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
    assertGitObjectId(ancestor);
    assertGitObjectId(descendant);
    const result = await this.git(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      this.root,
      120_000,
      undefined,
      signal,
      [0, 1],
    );
    return result.exitCode === 0;
  }

  /** Fast-forward-only merge, used to sync a checked-out default branch after fetch. */
  async mergeFastForwardOnly(directory: string, commit: string, signal?: AbortSignal): Promise<void> {
    assertGitObjectId(commit);
    await this.git(["merge", "--ff-only", commit], directory, 120_000, undefined, signal);
  }

  /** Advances `refs/heads/<branch>` only while it still points at `expectedOld`. */
  async updateRefFastForward(
    branch: string,
    newCommit: string,
    expectedOld: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertGitObjectId(newCommit);
    assertGitObjectId(expectedOld);
    await this.git(
      ["update-ref", `refs/heads/${branch}`, newCommit, expectedOld],
      this.root,
      120_000,
      undefined,
      signal,
    );
  }

  /** Creates a branch without checking it out (worktree creation happens separately). */
  async createBranch(name: string, startPoint: string, signal?: AbortSignal): Promise<void> {
    await this.git(["branch", name, startPoint], this.root, 120_000, undefined, signal);
  }

  async branchExists(name: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
      this.root,
      120_000,
      undefined,
      signal,
      [0, 1],
    );
    return result.exitCode === 0;
  }

  /** Validates a branch name with `git check-ref-format --branch`. */
  async assertValidBranchName(name: string, signal?: AbortSignal): Promise<void> {
    const result = await this.git(
      ["check-ref-format", "--branch", name],
      this.root,
      120_000,
      undefined,
      signal,
      [0, 1],
    );
    if (result.exitCode !== 0) {
      throw new Error(`Invalid Git branch name '${name}'`);
    }
  }

  /** Attached branch of the primary worktree; undefined when detached. */
  async currentBranchName(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      this.root,
      120_000,
      undefined,
      signal,
      [0, 1],
    );
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /**
   * Resolves the remote default branch via `git ls-remote --symref <remote> HEAD`,
   * e.g. `ref: refs/heads/main\tHEAD`. Returns undefined when unresolvable.
   */
  async remoteDefaultBranch(remote: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.git(
      ["ls-remote", "--symref", remote, "HEAD"],
      this.root,
      120_000,
      undefined,
      signal,
    );
    const match = result.stdout.match(/^ref: refs\/heads\/(.+?)\tHEAD$/m);
    return match?.[1];
  }

  /** Remote branch names mapped to their object ids (without `refs/heads/`). */
  async remoteBranches(remote: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const result = await this.git(
      ["ls-remote", "--heads", remote],
      this.root,
      120_000,
      undefined,
      signal,
    );
    const branches = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const [commit, ref] = line.trim().split(/\s+/);
      if (!commit || !ref || !ref.startsWith("refs/heads/")) {
        continue;
      }
      branches.set(ref.slice("refs/heads/".length), commit);
    }
    return branches;
  }

  private assertValidAuthorization(authorization: ExactTrackedFileCommitAuthorization): void {
    if (!authorization || typeof authorization !== "object") {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization is required",
      );
    }
    if (authorization.kind !== "exact-tracked-file-commit") {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization kind is invalid",
      );
    }
    if (typeof authorization.root !== "string" || !authorization.root) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization root is required",
      );
    }
    if (typeof authorization.head !== "string" || !authorization.head) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization head is required",
      );
    }
    if (!isGitObjectId(authorization.head)) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization HEAD is invalid",
      );
    }
    if (
      typeof authorization.repositoryRelativePath !== "string" ||
      !authorization.repositoryRelativePath
    ) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization path is required",
      );
    }
    if (
      typeof authorization.issuedAtMs !== "number" ||
      !Number.isFinite(authorization.issuedAtMs)
    ) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization timestamp is required",
      );
    }
    if (!this.#issuedExactFileAuthorizations.has(authorization)) {
      throw new GitManagerError(
        "GIT_INVALID_AUTHORIZATION",
        "Exact-file commit authorization was not issued by this GitManager instance or was already consumed",
      );
    }
  }

  private async resolveCanonicalPrimaryRoot(): Promise<string> {
    const [topLevel, gitDirectory, commonDirectory] = await Promise.all([
      this.git(["rev-parse", "--show-toplevel"], this.root),
      this.git(["rev-parse", "--absolute-git-dir"], this.root),
      this.git(["rev-parse", "--git-common-dir"], this.root),
    ]);
    const configuredRoot = await realpath(this.root);
    const [gitRoot, canonicalGitDirectory, canonicalCommonDirectory] = await Promise.all([
      realpath(topLevel.stdout.trim()),
      realpath(resolveGitMetadataPath(configuredRoot, gitDirectory.stdout.trim())),
      realpath(resolveGitMetadataPath(configuredRoot, commonDirectory.stdout.trim())),
    ]);
    if (gitRoot !== configuredRoot) {
      throw new GitManagerError(
        "GIT_UNSAFE_PATH",
        `Configuration root '${this.root}' must be the Git repository root`,
      );
    }
    if (canonicalGitDirectory !== canonicalCommonDirectory) {
      throw new GitManagerError(
        "GIT_UNSAFE_PATH",
        `Exact-file commits require the primary Git worktree: ${gitRoot}`,
      );
    }
    return gitRoot;
  }

  private async assertTrackedRegularFile(root: string, repositoryRelativePath: string): Promise<void> {
    const absolute = path.resolve(root, repositoryRelativePath);
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (absolute !== root && !absolute.startsWith(rootPrefix)) {
      throw new GitManagerError(
        "GIT_UNSAFE_PATH",
        `Exact-file path escapes repository root: ${repositoryRelativePath}`,
      );
    }

    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (isNotFound(error)) {
        throw new GitManagerError(
          "GIT_UNSAFE_PATH",
          `Exact-file path does not exist: ${repositoryRelativePath}`,
        );
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new GitManagerError(
        "GIT_UNSAFE_PATH",
        `Exact-file path must be a regular non-symlink file: ${repositoryRelativePath}`,
      );
    }
    const canonicalTarget = await realpath(absolute);
    if (canonicalTarget !== absolute) {
      throw new GitManagerError(
        "GIT_UNSAFE_PATH",
        `Exact-file path must not traverse symbolic links: ${repositoryRelativePath}`,
      );
    }

    // Confirm the path is tracked in HEAD (already-authorized tracked file).
    const tracked = await this.git(
      ["ls-files", "-z", "--error-unmatch", "--", repositoryRelativePath],
      root,
    ).catch((error: unknown) => {
      throw new GitManagerError(
        "GIT_TARGET_NOT_TRACKED",
        `Exact-file path is not a tracked repository file: ${repositoryRelativePath}${
          error instanceof Error ? ` (${error.message})` : ""
        }`,
      );
    });
    const trackedPaths = parseNulFields(tracked.stdout);
    if (trackedPaths.length !== 1 || trackedPaths[0] !== repositoryRelativePath) {
      throw new GitManagerError(
        "GIT_TARGET_NOT_TRACKED",
        `Exact-file path is not a tracked repository file: ${repositoryRelativePath}`,
      );
    }
  }

  private async pathDiff(
    directory: string,
    filePath: string,
    maxCharacters: number,
    signal?: AbortSignal,
  ): Promise<GitWorktreeDiff> {
    const normalized = normalizeRepositoryRelativePath(filePath);
    const entries = await this.porcelainStatus(directory, signal);
    const entry = entries.find((item) => item.path === normalized);
    if (!entry) {
      return { content: "这个文件当前没有未提交改动。", truncated: false };
    }
    if (entry.xy.includes("?")) {
      const stats = await this.untrackedStat(directory, normalized);
      if (stats.binary) {
        return { content: "二进制文件，不显示 diff", truncated: false, binary: true };
      }
      try {
        const raw = await readFile(path.join(directory, ...normalized.split("/")), "utf8");
        const truncated = raw.length > maxCharacters;
        return {
          content: truncated ? `${raw.slice(0, maxCharacters)}\n\n[diff truncated]` : raw,
          truncated,
        };
      } catch {
        return { content: "无法读取未跟踪文件。", truncated: false };
      }
    }
    const result = await this.git(
      ["diff", "--no-ext-diff", "--unified=40", "HEAD", "--", normalized],
      directory,
      120_000,
      undefined,
      signal,
    );
    if (result.stdout.includes("Binary files") || result.stdout.includes("GIT binary patch")) {
      return { content: "二进制文件，不显示 diff", truncated: false, binary: true };
    }
    const truncated = result.stdout.length > maxCharacters;
    return {
      content: truncated ? `${result.stdout.slice(0, maxCharacters)}\n\n[diff truncated]` : result.stdout,
      truncated,
    };
  }

  private async numstatAgainstHead(
    directory: string,
    signal?: AbortSignal,
  ): Promise<Map<string, { insertions: number; deletions: number; binary: boolean }>> {
    const result = await this.git(
      ["diff", "--numstat", "HEAD"],
      directory,
      120_000,
      undefined,
      signal,
      [0, 128],
    );
    const stats = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
    if (result.exitCode !== 0) return stats;
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!match) continue;
      const filePath = match[3]!.includes(" => ")
        ? match[3]!.split(" => ").at(-1)!.replace(/[{}]/g, "")
        : match[3]!;
      const binary = match[1] === "-" || match[2] === "-";
      stats.set(filePath, {
        insertions: binary ? 0 : Number(match[1]),
        deletions: binary ? 0 : Number(match[2]),
        binary,
      });
    }
    return stats;
  }

  private async untrackedStat(
    directory: string,
    filePath: string,
  ): Promise<{ insertions: number; deletions: number; binary: boolean }> {
    try {
      const absolute = path.join(directory, ...filePath.split("/"));
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > UNTRACKED_PREVIEW_BYTES) {
        return { insertions: 0, deletions: 0, binary: true };
      }
      const raw = await readFile(absolute);
      if (raw.includes(0)) {
        return { insertions: 0, deletions: 0, binary: true };
      }
      const text = raw.toString("utf8");
      const lines = text === "" ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
      return { insertions: Math.max(lines, text ? 1 : 0), deletions: 0, binary: false };
    } catch {
      return { insertions: 0, deletions: 0, binary: false };
    }
  }

  private async porcelainStatus(
    directory: string,
    signal?: AbortSignal,
  ): Promise<Array<{ xy: string; path: string; originalPath?: string }>> {
    const result = await this.git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      directory,
      120_000,
      undefined,
      signal,
    );
    const entries: Array<{ xy: string; path: string; originalPath?: string }> = [];
    const fields = parseNulFields(result.stdout);
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (field.length < 4 || field[2] !== " ") {
        throw new GitManagerError(
          "GIT_OPERATION_FAILED",
          `Unrecognized NUL-delimited git status entry: ${JSON.stringify(field)}`,
        );
      }
      const xy = field.slice(0, 2);
      const statusPath = field.slice(3);
      if (xy.includes("R") || xy.includes("C")) {
        const originalPath = fields[index + 1];
        if (originalPath === undefined) {
          throw new GitManagerError(
            "GIT_OPERATION_FAILED",
            `Missing original path for git status rename: ${JSON.stringify(field)}`,
          );
        }
        entries.push({ xy, path: statusPath, originalPath });
        index += 1;
        continue;
      }
      entries.push({ xy, path: statusPath });
    }
    return entries;
  }

  private assertManagedPath(directory: string): void {
    const managedRoot = path.resolve(this.worktreesRoot);
    const resolved = path.resolve(directory);
    if (resolved === managedRoot || !resolved.startsWith(`${managedRoot}${path.sep}`)) {
      throw new Error(`Refusing worktree operation outside '${managedRoot}': ${resolved}`);
    }
  }

  private async git(
    args: string[],
    cwd: string,
    timeoutMs = 120_000,
    stdin?: string,
    signal?: AbortSignal,
    allowedExitCodes: number[] = [0],
  ): Promise<ProcessResult> {
    const result = await runProcess({
      command: "git",
      args,
      cwd,
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode)) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }
}

export function normalizeRepositoryRelativePath(input: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new GitManagerError("GIT_UNSAFE_PATH", "Repository-relative path is required");
  }
  if (input.includes("\0")) {
    throw new GitManagerError("GIT_UNSAFE_PATH", "Repository-relative path must not contain NUL");
  }
  if (input !== input.trim()) {
    throw new GitManagerError(
      "GIT_UNSAFE_PATH",
      "Repository-relative path must not include leading or trailing whitespace",
    );
  }
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new GitManagerError(
      "GIT_UNSAFE_PATH",
      "Exact-file path must be repository-relative (absolute paths are not allowed)",
    );
  }
  if (input.includes("\\")) {
    throw new GitManagerError(
      "GIT_UNSAFE_PATH",
      "Exact-file path must use POSIX separators only",
    );
  }
  if (input.startsWith("./") || input.includes("/./") || input.endsWith("/.")) {
    throw new GitManagerError(
      "GIT_UNSAFE_PATH",
      "Exact-file path must be normalized without '.' segments",
    );
  }
  const segments = input.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new GitManagerError(
      "GIT_UNSAFE_PATH",
      "Exact-file path must not contain empty, '.', or '..' segments",
    );
  }
  return segments.join("/");
}

function uniqueNormalizedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of paths) {
    const next = normalizeRepositoryRelativePath(item);
    if (seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function changeOrigin(filePath: string): "user" | "agent" {
  return filePath.startsWith("agent-team/") || filePath.includes("/.agent-team/") ? "agent" : "user";
}

function porcelainLabel(xy: string): string {
  const code = xy.replace(/ /g, "");
  if (xy.includes("?")) return "未跟踪";
  if (xy.includes("A")) return "新增";
  if (xy.includes("D")) return "删除";
  if (xy.includes("R")) return "重命名";
  if (xy.includes("C")) return "复制";
  if (xy.includes("U") || xy === "DD" || xy === "AA") return "冲突";
  if (xy.includes("M")) return "已修改";
  return code || "已改动";
}

function formatStatusEntries(
  entries: ReadonlyArray<{ xy: string; path: string }>,
): string {
  return entries.map((entry) => `${entry.xy} ${JSON.stringify(entry.path)}`).join(", ");
}

function assertGitObjectId(value: string): void {
  if (!isGitObjectId(value)) {
    throw new Error(`Invalid Git object ID '${value}'`);
  }
}

function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

function parseNulFields(output: string): string[] {
  if (!output) return [];
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function resolveGitMetadataPath(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
