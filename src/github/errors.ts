/**
 * Distinguishable GitHub publication failures.
 *
 * The UI surfaces these messages verbatim, so each kind maps to a distinct,
 * actionable prompt instead of a raw `gh` error line.
 */

export type GithubFailureKind =
  | "github-disabled"
  | "not-logged-in"
  | "no-saved-account"
  | "no-git-identity"
  | "token-permissions"
  | "network"
  | "base-missing"
  | "other";

export class GithubActionError extends Error {
  readonly kind: GithubFailureKind;
  readonly code = "GITHUB_ACTION_FAILED";

  constructor(kind: GithubFailureKind, message: string) {
    super(message);
    this.name = "GithubActionError";
    this.kind = kind;
  }
}

export function githubActionError(kind: GithubFailureKind, detail: string): GithubActionError {
  return new GithubActionError(kind, githubFailureMessage(kind, detail));
}

export function classifyGithubFailure(error: unknown): GithubActionError {
  const text = error instanceof Error ? error.message : String(error);
  return githubActionError(classifyGithubFailureKind(text), text);
}

export function classifyGithubFailureKind(text: string): GithubFailureKind {
  if (/disabled in agent-team\.yaml/i.test(text)) {
    return "github-disabled";
  }
  if (/no (authenticated )?account|no accounts|auth status/i.test(text)) {
    return "no-saved-account";
  }
  if (/log in|not logged in|please run gh auth|auth login/i.test(text)) {
    return "not-logged-in";
  }
  if (/tell me who you are|user\.name|user\.email|committer identity/i.test(text)) {
    return "no-git-identity";
  }
  if (
    /resource not accessible|insufficient|permissions?|forbidden|403|bad credentials|token|scope|authorization/i.test(
      text,
    )
  ) {
    return "token-permissions";
  }
  if (
    /ENOTFOUND|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|timed out|temporary failure/i.test(
      text,
    )
  ) {
    return "network";
  }
  return "other";
}

function githubFailureMessage(kind: GithubFailureKind, detail: string): string {
  switch (kind) {
    case "github-disabled":
      return "项目配置已关闭 GitHub 集成（agent-team.yaml 的 github.enabled: false），无法发布。可在配置中开启后重试。";
    case "not-logged-in":
      return "还没连接 GitHub。请在项目 Git 里点「连接 GitHub」，在打开的浏览器里授权本机 gh 后再试。";
    case "no-saved-account":
      return "本机还没有可用的 GitHub 账号。请在项目 Git 里点「连接 GitHub」绑定后再试。";
    case "no-git-identity":
      return "Git 未配置提交者身份：请设置 git config --global user.name 与 user.email 后重试。";
    case "token-permissions":
      return "GitHub 权限不足：无法推送分支或创建 PR。请在项目 Git 里点「补授权」，或确认这个账号有该仓库的 repo / PR 权限。";
    case "network":
      return "无法连接 GitHub：请检查网络后重试发布。";
    case "base-missing":
      return `PR 目标分支不在远端：${detail}。可在发布预览中确认并推送 base 分支后重试。`;
    case "other":
      return `发布失败：${detail}`;
  }
}
