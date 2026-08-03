import type { ProcessRequest, ProcessResult } from "../process/run.js";
import { runProcess } from "../process/run.js";

export interface RepositoryInfo {
  nameWithOwner: string;
  url: string;
  defaultBranch: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  state: string;
  mergedAt: string | null;
}

export interface GithubCheck {
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  completedAt: string;
  description: string;
  event: string;
  link: string;
  name: string;
  startedAt: string;
  state: string;
  workflow: string;
}

export type CheckSummary = "pass" | "fail" | "pending" | "none";

export class GithubClient {
  constructor(
    private readonly runner: (request: ProcessRequest) => Promise<ProcessResult> = runProcess,
    private readonly executable = "gh",
  ) {}

  async authStatus(cwd: string): Promise<void> {
    await this.gh(["auth", "status"], cwd);
  }

  async repository(cwd: string): Promise<RepositoryInfo> {
    const result = await this.gh(
      ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"],
      cwd,
    );
    const value = JSON.parse(result.stdout) as {
      nameWithOwner: string;
      url: string;
      defaultBranchRef: { name: string };
    };
    return {
      nameWithOwner: value.nameWithOwner,
      url: value.url,
      defaultBranch: value.defaultBranchRef.name,
    };
  }

  async findPullRequest(
    cwd: string,
    repository: string,
    branch: string,
  ): Promise<PullRequestInfo | undefined> {
    const result = await this.gh(
      [
        "pr",
        "view",
        branch,
        "--repo",
        repository,
        "--json",
        "number,url,state,mergedAt",
      ],
      cwd,
      [0, 1],
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return undefined;
    }
    return JSON.parse(result.stdout) as PullRequestInfo;
  }

  async createPullRequest(options: {
    cwd: string;
    repository: string;
    base: string;
    head: string;
    title: string;
    bodyFile: string;
    draft: boolean;
  }): Promise<PullRequestInfo> {
    const args = [
      "pr",
      "create",
      "--repo",
      options.repository,
      "--base",
      options.base,
      "--head",
      options.head,
      "--title",
      options.title,
      "--body-file",
      options.bodyFile,
    ];
    if (options.draft) {
      args.push("--draft");
    }
    const create = await this.gh(args, options.cwd);
    const url = create.stdout.trim().split("\n").at(-1)?.trim();
    if (!url) {
      throw new Error("GitHub did not return a pull request URL");
    }
    return await this.pullRequest(options.cwd, options.repository, url);
  }

  async pullRequest(cwd: string, repository: string, target: string): Promise<PullRequestInfo> {
    const result = await this.gh(
      [
        "pr",
        "view",
        target,
        "--repo",
        repository,
        "--json",
        "number,url,state,mergedAt",
      ],
      cwd,
    );
    return JSON.parse(result.stdout) as PullRequestInfo;
  }

  async checks(cwd: string, repository: string, target: string): Promise<GithubCheck[]> {
    const result = await this.gh(
      [
        "pr",
        "checks",
        target,
        "--repo",
        repository,
        "--json",
        "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
      ],
      cwd,
      [0, 1, 8],
    );
    if (!result.stdout.trim()) {
      return [];
    }
    return JSON.parse(result.stdout) as GithubCheck[];
  }

  async failedLogs(cwd: string, repository: string, checks: GithubCheck[]): Promise<string> {
    const runIds = new Set(
      checks
        .filter((check) => check.bucket === "fail" || check.bucket === "cancel")
        .map((check) => check.link.match(/\/actions\/runs\/(\d+)/)?.[1])
        .filter((value): value is string => Boolean(value)),
    );
    const logs: string[] = [];
    for (const runId of runIds) {
      const result = await this.gh(
        ["run", "view", runId, "--repo", repository, "--log-failed"],
        cwd,
        [0, 1],
      );
      logs.push(`## GitHub Actions run ${runId}\n${result.stdout || result.stderr}`);
    }
    return logs.join("\n\n").slice(-160_000);
  }

  async waitForChecks(options: {
    cwd: string;
    repository: string;
    target: string;
    timeoutSeconds: number;
    intervalMs?: number;
  }): Promise<GithubCheck[]> {
    const deadline = Date.now() + options.timeoutSeconds * 1_000;
    while (true) {
      const checks = await this.checks(options.cwd, options.repository, options.target);
      const summary = summarizeChecks(checks);
      if (summary !== "pending" && summary !== "none") {
        return checks;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for GitHub checks after ${options.timeoutSeconds}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 10_000));
    }
  }

  private async gh(
    args: string[],
    cwd: string,
    allowedExitCodes: number[] = [0],
  ): Promise<ProcessResult> {
    const result = await this.runner({
      command: this.executable,
      args,
      cwd,
      timeoutMs: 300_000,
    });
    if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode)) {
      throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }
}

export function summarizeChecks(checks: GithubCheck[]): CheckSummary {
  if (checks.length === 0) {
    return "none";
  }
  if (checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
    return "fail";
  }
  if (checks.some((check) => check.bucket === "pending")) {
    return "pending";
  }
  return "pass";
}
