import { describe, expect, it } from "vitest";
import {
  GithubClient,
  parseGhJson,
  summarizeChecks,
  type GithubCheck,
} from "../src/github/client.js";
import type { ProcessRequest, ProcessResult } from "../src/process/run.js";

function result(
  request: ProcessRequest,
  stdout: string,
  exitCode = 0,
): ProcessResult {
  return {
    command: request.command,
    args: request.args,
    exitCode,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    signal: null,
  };
}

describe("GithubClient", () => {
  it("creates pull requests through argument arrays", async () => {
    const requests: ProcessRequest[] = [];
    const client = new GithubClient(async (request) => {
      requests.push(request);
      if (request.args[1] === "create") {
        return result(request, "https://github.com/acme/repo/pull/7\n");
      }
      return result(
        request,
        JSON.stringify({
          number: 7,
          url: "https://github.com/acme/repo/pull/7",
          state: "OPEN",
          mergedAt: null,
          isDraft: false,
        }),
      );
    });

    const pullRequest = await client.createPullRequest({
      cwd: "/tmp/repo",
      repository: "acme/repo",
      base: "main",
      head: "agent-team/run/integration",
      title: "Test PR",
      bodyFile: "/tmp/body.md",
      draft: true,
    });

    expect(pullRequest.number).toBe(7);
    expect(requests[0]?.command).toBe("gh");
    expect(requests[0]?.args).toContain("--draft");
    expect(requests[0]?.args).toContain("agent-team/run/integration");
  });

  it("omits --draft for formal pull requests", async () => {
    const requests: ProcessRequest[] = [];
    const client = new GithubClient(async (request) => {
      requests.push(request);
      if (request.args[1] === "create") {
        return result(request, "https://github.com/acme/repo/pull/8\n");
      }
      return result(
        request,
        JSON.stringify({
          number: 8,
          url: "https://github.com/acme/repo/pull/8",
          state: "OPEN",
          mergedAt: null,
          isDraft: false,
        }),
      );
    });

    await client.createPullRequest({
      cwd: "/tmp/repo",
      repository: "acme/repo",
      base: "main",
      head: "feature/goal",
      title: "Formal PR",
      bodyFile: "/tmp/body.md",
      draft: false,
    });

    expect(requests[0]?.args).not.toContain("--draft");
  });

  it("marks an existing draft PR ready without a shell", async () => {
    const requests: ProcessRequest[] = [];
    const client = new GithubClient(async (request) => {
      requests.push(request);
      return result(request, "");
    });

    await client.markPullRequestReady("/tmp/repo", "acme/repo", "https://github.com/acme/repo/pull/9");

    expect(requests[0]?.command).toBe("gh");
    expect(requests[0]?.args).toEqual([
      "pr",
      "ready",
      "https://github.com/acme/repo/pull/9",
      "--repo",
      "acme/repo",
    ]);
  });

  it("summarizes check buckets conservatively", () => {
    const check = (bucket: GithubCheck["bucket"]): GithubCheck => ({
      bucket,
      completedAt: "",
      description: "",
      event: "pull_request",
      link: "",
      name: bucket,
      startedAt: "",
      state: bucket,
      workflow: "CI",
    });
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks([check("pass"), check("skipping")])).toBe("pass");
    expect(summarizeChecks([check("pass"), check("pending")])).toBe("pending");
    expect(summarizeChecks([check("pass"), check("fail")])).toBe("fail");
  });

  it("reports command context and a bounded excerpt when gh output is not JSON", async () => {
    const polluted = `${"not-json".repeat(40)}\n`;
    const client = new GithubClient(async (request) => result(request, polluted));

    await expect(client.repository("/tmp/repo")).rejects.toThrow(
      /gh repo view --json nameWithOwner,url,defaultBranchRef returned invalid JSON/,
    );
    const failure = await client.repository("/tmp/repo").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("not-json");
    expect(message.length).toBeLessThan(polluted.length + 200);

    await expect(client.pullRequest("/tmp/repo", "acme/repo", "7")).rejects.toThrow(
      /gh pr view 7 --json number,url,state,mergedAt,isDraft returned invalid JSON/,
    );
    await expect(client.checks("/tmp/repo", "acme/repo", "7")).rejects.toThrow(
      /gh pr checks 7 .* returned invalid JSON/,
    );
  });

  it("reads an account snapshot without requesting the token", async () => {
    const requests: ProcessRequest[] = [];
    const client = new GithubClient(async (request) => {
      requests.push(request);
      if (request.args[0] === "--version") return result(request, "gh 2.0.0\n");
      return result(
        request,
        JSON.stringify({
          hosts: {
            "github.com": [
              {
                state: "success",
                active: true,
                login: "octo",
                token: "ghp_hidden",
                scopes: ["repo"],
                tokenSource: "keyring",
                gitProtocol: "https",
              },
            ],
          },
        }),
      );
    });

    const snapshot = await client.authSnapshot("/tmp/repo", "github.com");
    expect(snapshot).toMatchObject({
      installed: true,
      authenticated: true,
      login: "octo",
      scopes: ["repo"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("ghp_");
    expect(requests[1]?.args).toEqual(["auth", "status", "--hostname", "github.com", "--json", "hosts"]);
    expect(requests[1]?.args).not.toContain("--show-token");
  });

  it("parses well-formed gh JSON output unchanged", () => {
    expect(parseGhJson('{"a": 1}', "gh example")).toEqual({ a: 1 });
    expect(() => parseGhJson("garbage", "gh example")).toThrow(
      "gh example returned invalid JSON: garbage",
    );
  });
});
