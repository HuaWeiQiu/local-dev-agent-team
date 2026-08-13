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
      return "未登录 GitHub CLI：请在本机终端运行 gh auth login 登录后重试发布。";
    case "no-saved-account":
      return "本地未保存 GitHub 账户信息：请运行 gh auth login 绑定账户后重试发布。";
    case "no-git-identity":
      return "Git 未配置提交者身份：请设置 git config --global user.name 与 user.email 后重试。";
    case "token-permissions":
      return "GitHub Token 权限不足：无法推送分支或创建 PR，请在 gh auth login（或 Token 设置）中授予 repo 与 PR 权限后重试。";
    case "network":
      return "无法连接 GitHub：请检查网络后重试发布。";
    case "other":
      return `发布失败：${detail}`;
  }
}
