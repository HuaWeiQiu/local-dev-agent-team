import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { runProcess, type ProcessResult } from "../process/run.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export class GitManager {
  constructor(
    readonly root: string,
    readonly worktreesRoot: string,
  ) {}

  async assertReady(): Promise<void> {
    const topLevel = await this.git(["rev-parse", "--show-toplevel"], this.root);
    const [gitRoot, configuredRoot] = await Promise.all([
      realpath(topLevel.stdout.trim()),
      realpath(this.root),
    ]);
    if (gitRoot !== configuredRoot) {
      throw new Error(`Configuration root '${this.root}' must be the Git repository root`);
    }
    if (!(await this.isClean(this.root))) {
      throw new Error("The primary Git worktree must be clean before starting a run");
    }
  }

  async resolveCommit(ref: string): Promise<string> {
    return (await this.git(["rev-parse", ref], this.root)).stdout.trim();
  }

  async createWorktree(branch: string, startPoint: string, directory: string): Promise<WorktreeInfo> {
    this.assertManagedPath(directory);
    await mkdir(path.dirname(directory), { recursive: true });
    await this.git(["worktree", "add", "-b", branch, directory, startPoint], this.root);
    return { path: directory, branch };
  }

  async removeWorktree(directory: string): Promise<void> {
    this.assertManagedPath(directory);
    await this.git(["worktree", "remove", directory], this.root);
  }

  async stage(directory: string): Promise<void> {
    await this.git(["add", "--all"], directory);
  }

  async changedFiles(directory: string): Promise<string[]> {
    const result = await this.git(["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB"], directory);
    return result.stdout
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async stagedDiff(directory: string, maxCharacters = 160_000): Promise<string> {
    const result = await this.git(["diff", "--cached", "--no-ext-diff", "--unified=60"], directory);
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

  async commit(directory: string, message: string): Promise<string> {
    await this.git(["commit", "-m", message], directory);
    return (await this.git(["rev-parse", "HEAD"], directory)).stdout.trim();
  }

  async merge(integrationDirectory: string, branch: string, message: string): Promise<string> {
    await this.git(["merge", "--no-ff", branch, "-m", message], integrationDirectory);
    return (await this.git(["rev-parse", "HEAD"], integrationDirectory)).stdout.trim();
  }

  async diffSummary(directory: string, baseRef: string): Promise<string> {
    return (await this.git(["diff", "--stat", `${baseRef}...HEAD`], directory)).stdout.trim();
  }

  async currentCommit(directory: string): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], directory)).stdout.trim();
  }

  async isClean(directory: string): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"], directory);
    return status.stdout.trim().length === 0;
  }

  async push(directory: string, remote: string, branch: string): Promise<void> {
    await this.git(["push", "--set-upstream", remote, branch], directory, 300_000);
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
  ): Promise<ProcessResult> {
    const result = await runProcess({ command: "git", args, cwd, timeoutMs });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }
}
