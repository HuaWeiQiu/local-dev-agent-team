import { afterEach, describe, expect, it } from "vitest";
import {
  githubAuthStatusArgs,
  githubLoginArgs,
  githubRefreshArgs,
  parseGithubAuthHosts,
  resetGithubConnectSessions,
  startGithubConnect,
  stripGithubSecrets,
  waitForGithubConnect,
} from "../src/github/auth.js";
import type { ProcessRequest, ProcessResult } from "../src/process/run.js";

afterEach(() => {
  resetGithubConnectSessions();
});

describe("GitHub auth snapshot sanitization", () => {
  it("drops token fields and redacts token-shaped strings", () => {
    const cleaned = stripGithubSecrets({
      hosts: {
        "github.com": [
          {
            login: "octo",
            token: "ghp_shouldNeverLeak",
            nested: { accessToken: "gho_alsoSecret" },
            note: "safe",
          },
        ],
      },
    }) as { hosts: { "github.com": Array<Record<string, unknown>> } };
    expect(cleaned.hosts["github.com"][0]).toEqual({ login: "octo", nested: {}, note: "safe" });
    expect(JSON.stringify(cleaned)).not.toMatch(/ghp_|gho_/);
  });

  it("parses the active account without requiring a hosts wrapper", () => {
    const parsed = parseGithubAuthHosts(
      JSON.stringify({
        "github.com": [
          { state: "success", active: true, login: "HuaWeiQiu", token: "ghp_nope", scopes: "repo, workflow", tokenSource: "keyring", gitProtocol: "https" },
        ],
      }),
      "github.com",
    );
    expect(parsed).toMatchObject({
      authenticated: true,
      login: "HuaWeiQiu",
      scopes: ["repo", "workflow"],
      tokenSource: "keyring",
      gitProtocol: "https",
    });
    expect(JSON.stringify(parsed)).not.toContain("ghp_");
  });
});

describe("GitHub connect session", () => {
  it("starts login with a web argv and does not spawn a second browser", async () => {
    const requests: ProcessRequest[] = [];
    const first = startGithubConnect({
      root: "/tmp/connect-one",
      host: "github.com",
      runner: async (request) => {
        requests.push(request);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return processResult(request, 0);
      },
    });
    const second = startGithubConnect({
      root: "/tmp/connect-one",
      host: "github.com",
      runner: async (request) => {
        requests.push(request);
        return processResult(request, 0);
      },
    });
    expect(first.id).toBe(second.id);
    expect(first.status === "starting" || first.status === "waiting-browser").toBe(true);
    await waitForGithubConnect("/tmp/connect-one");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toBe("gh");
    expect(requests[0]?.args).toEqual(githubLoginArgs("github.com"));
    expect(requests[0]?.args).not.toContain("--show-token");
  });

  it("uses refresh scopes when the user asks to repair permissions", async () => {
    const requests: ProcessRequest[] = [];
    startGithubConnect({
      root: "/tmp/connect-refresh",
      host: "github.example.com",
      action: "refresh",
      runner: async (request) => {
        requests.push(request);
        return processResult(request, 0);
      },
    });
    const done = await waitForGithubConnect("/tmp/connect-refresh");
    expect(done).toMatchObject({ status: "succeeded", action: "refresh" });
    expect(requests[0]?.args).toEqual(githubRefreshArgs("github.example.com"));
  });

  it("records a failed browser login without leaking argv secrets", async () => {
    startGithubConnect({
      root: "/tmp/connect-fail",
      host: "github.com",
      runner: async (request) => processResult(request, 1, "please run gh auth login"),
    });
    const done = await waitForGithubConnect("/tmp/connect-fail");
    expect(done).toMatchObject({ status: "failed" });
    if (done.status !== "idle") {
      expect(done.error).toContain("连接 GitHub");
    }
  });
});

describe("gh argv helpers", () => {
  it("never asks gh to print a token", () => {
    expect(githubAuthStatusArgs("github.com")).toEqual([
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--json",
      "hosts",
    ]);
    expect(githubAuthStatusArgs("github.com").join(" ")).not.toContain("show-token");
  });
});

function processResult(request: ProcessRequest, exitCode: number, stderr = ""): ProcessResult {
  return {
    command: request.command,
    args: request.args,
    exitCode,
    stdout: "",
    stderr,
    durationMs: 1,
    timedOut: false,
    signal: null,
  };
}
