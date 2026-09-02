import { LoaderCircle, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getGithubConnect, startGithubConnect } from "../api";
import type { GithubAccountSnapshot, GithubConnectSession, ProjectScope } from "../types";

interface GithubConnectBarProps {
  scope: ProjectScope;
  account?: GithubAccountSnapshot | undefined;
  disabled?: boolean;
  onChanged(): Promise<void> | void;
}

export function GithubConnectBar({ scope, account, disabled, onChanged }: GithubConnectBarProps) {
  const [session, setSession] = useState<GithubConnectSession>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const waiting = session?.status === "starting" || session?.status === "waiting-browser";

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      void getGithubConnect(scope)
        .then((next) => {
          setSession(next);
          if (next.status === "succeeded") void onChanged();
          if (next.status === "failed" || next.status === "cancelled") {
            setError(next.error);
          }
        })
        .catch((requestError: unknown) => {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [onChanged, scope, waiting]);

  const run = async (action: "login" | "refresh" | "cancel") => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await startGithubConnect(scope, action);
      setSession(next);
      if (next.status === "succeeded") await onChanged();
      if (next.status === "failed" || next.status === "cancelled") setError(next.error);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const state = account?.state ?? "logged-out";
  const label = accountLabel(account, waiting);

  return (
    <div className="github-connect-bar">
      <span className={`git-capability ${capabilityClass(state, waiting)}`} title={account?.detail ?? label}>
        <LogIn size={13} />
        {label}
      </span>
      {state === "missing-cli" ? (
        <a className="button secondary compact" href="https://cli.github.com/" target="_blank" rel="noreferrer">
          安装 GitHub CLI
        </a>
      ) : waiting ? (
        <button type="button" className="button secondary compact" disabled={busy || disabled} onClick={() => void run("cancel")}>
          <LoaderCircle size={13} className="spin" />我已取消
        </button>
      ) : state === "insufficient" ? (
        <button type="button" className="button primary compact" disabled={busy || disabled} onClick={() => void run("refresh")}>
          <RefreshCw size={13} />补授权
        </button>
      ) : state === "logged-in" ? (
        <button type="button" className="button secondary compact" disabled={busy || disabled} onClick={() => void run("login")}>
          重新连接
        </button>
      ) : (
        <button type="button" className="button primary compact" disabled={busy || disabled} onClick={() => void run("login")}>
          <LogIn size={13} />连接 GitHub
        </button>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function accountLabel(account: GithubAccountSnapshot | undefined, waiting: boolean): string {
  if (waiting) return "正在打开 GitHub 登录…";
  if (!account) return "未连接 GitHub";
  if (account.state === "logged-in" && account.login) {
    return account.repoNameWithOwner
      ? `${account.login} · ${account.repoNameWithOwner}`
      : `${account.login}@${account.host}`;
  }
  if (account.state === "insufficient") return account.login ? `${account.login} · 权限不足` : "已登录但没有仓库权限";
  if (account.state === "missing-cli") return "未安装 gh";
  return "未连接 GitHub";
}

function capabilityClass(
  state: GithubAccountSnapshot["state"],
  waiting: boolean,
): "is-ok" | "is-bad" | "is-warn" {
  if (waiting) return "is-warn";
  if (state === "logged-in") return "is-ok";
  if (state === "insufficient") return "is-warn";
  return "is-bad";
}
