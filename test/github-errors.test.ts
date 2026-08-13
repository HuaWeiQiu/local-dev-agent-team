import { describe, expect, it } from "vitest";
import {
  classifyGithubFailure,
  classifyGithubFailureKind,
  githubActionError,
  GithubActionError,
} from "../src/github/errors.js";

describe("GitHub failure classification", () => {
  it("distinguishes every operator-facing failure kind", () => {
    expect(classifyGithubFailureKind("GitHub integration is disabled in agent-team.yaml")).toBe(
      "github-disabled",
    );
    expect(classifyGithubFailureKind("Please log in to GitHub.com..." )).toBe("not-logged-in");
    expect(classifyGithubFailureKind("no authenticated account found")).toBe("no-saved-account");
    expect(classifyGithubFailureKind("Please tell me who you are.\n\nRun git config user.name")).toBe(
      "no-git-identity",
    );
    expect(classifyGithubFailureKind("Resource not accessible by integration")).toBe(
      "token-permissions",
    );
    expect(classifyGithubFailureKind("Bad credentials (403)")).toBe("token-permissions");
    expect(classifyGithubFailureKind("ENOTFOUND github.com")).toBe("network");
    expect(classifyGithubFailureKind("some unexpected failure")).toBe("other");
  });

  it("renders distinct, actionable Chinese prompts", () => {
    const cases: Array<[string, string]> = [
      ["github-disabled", "已关闭 GitHub 集成"],
      ["not-logged-in", "未登录 GitHub CLI"],
      ["no-saved-account", "未保存 GitHub 账户信息"],
      ["no-git-identity", "未配置提交者身份"],
      ["token-permissions", "权限不足"],
      ["network", "无法连接 GitHub"],
    ];
    for (const [kind, expected] of cases) {
      const error = githubActionError(kind as Parameters<typeof githubActionError>[0], "detail");
      expect(error).toBeInstanceOf(GithubActionError);
      expect(error.kind).toBe(kind);
      expect(error.code).toBe("GITHUB_ACTION_FAILED");
      expect(error.message).toContain(expected);
    }
  });

  it("preserves raw detail for unclassified failures", () => {
    const error = classifyGithubFailure(new Error("gh pr create blew up"));
    expect(error.kind).toBe("other");
    expect(error.message).toContain("gh pr create blew up");
  });
});
