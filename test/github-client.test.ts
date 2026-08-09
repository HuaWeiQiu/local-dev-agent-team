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
      /gh pr view 7 --json number,url,state,mergedAt returned invalid JSON/,
    );
    await expect(client.checks("/tmp/repo", "acme/repo", "7")).rejects.toThrow(
      /gh pr checks 7 .* returned invalid JSON/,
    );
  });

  it("parses well-formed gh JSON output unchanged", () => {
    expect(parseGhJson('{"a": 1}', "gh example")).toEqual({ a: 1 });
    expect(() => parseGhJson("garbage", "gh example")).toThrow(
      "gh example returned invalid JSON: garbage",
    );
  });
});
