import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
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
      (file) => !patterns.some((pattern) => minimatch(file, pattern, { dot: true })),
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

  private async porcelainStatus(
    directory: string,
  ): Promise<Array<{ xy: string; path: string; originalPath?: string }>> {
    const result = await this.git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      directory,
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
  ): Promise<ProcessResult> {
    const result = await runProcess({
      command: "git",
      args,
      cwd,
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }
}

function normalizeRepositoryRelativePath(input: string): string {
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
