import { randomUUID } from "node:crypto";
import { parseGitRemoteOwner } from "../git/remote-policy.js";
import { runProcess, type ProcessRequest, type ProcessResult } from "../process/run.js";
import { classifyGithubFailure } from "./errors.js";

export const GITHUB_CONNECT_TIMEOUT_MS = 600_000;
export const GITHUB_DEFAULT_HOST = "github.com";
const GITHUB_REFRESH_SCOPES = "repo,read:org,workflow";

export type GithubConnectAction = "login" | "refresh" | "cancel";
export type GithubAccountState =
  | "missing-cli"
  | "logged-out"
  | "logged-in"
  | "insufficient"
  | "error";

export interface GithubAccountSnapshot {
  host: string;
  login?: string;
  state: GithubAccountState;
  scopes: string[];
  tokenSource?: "keyring" | "env" | "plaintext" | "unknown";
  gitProtocol?: "https" | "ssh";
  repoNameWithOwner?: string;
  canLogin: boolean;
  canPush: boolean;
  canPublish: boolean;
  detail?: string;
}

export interface GithubConnectSession {
  id: string;
  action: Exclude<GithubConnectAction, "cancel">;
  host: string;
  status: "starting" | "waiting-browser" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  login?: string;
  error?: string;
}

export type GithubConnectView = GithubConnectSession | { status: "idle" };

export type GithubProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

interface LiveConnect {
  session: GithubConnectSession;
  abort: AbortController;
  done: Promise<void>;
}

const sessions = new Map<string, LiveConnect>();

export function githubHostFromRemoteUrl(remoteUrl?: string): string {
  return parseGitRemoteOwner(remoteUrl ?? "")?.host ?? GITHUB_DEFAULT_HOST;
}

export function githubLoginArgs(host: string): string[] {
  return ["auth", "login", "--web", "--git-protocol", "https", "--hostname", host];
}

export function githubRefreshArgs(host: string): string[] {
  return ["auth", "refresh", "--hostname", host, "--scopes", GITHUB_REFRESH_SCOPES];
}

export function githubAuthStatusArgs(host: string): string[] {
  return ["auth", "status", "--hostname", host, "--json", "hosts"];
}

/** Recursively drop token-like fields before any log or UI projection. */
export function stripGithubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripGithubSecrets(item));
  }
  if (!value || typeof value !== "object") {
    return redactSecretString(value);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token/i.test(key) && key.toLowerCase() !== "tokensource") continue;
    output[key] = stripGithubSecrets(item);
  }
  return output;
}

export function parseGithubAuthHosts(
  raw: string,
  host: string,
): {
  login?: string;
  scopes: string[];
  tokenSource?: GithubAccountSnapshot["tokenSource"];
  gitProtocol?: GithubAccountSnapshot["gitProtocol"];
  authenticated: boolean;
} {
  const parsed = stripGithubSecrets(JSON.parse(raw)) as Record<string, unknown>;
  const hosts = (isRecord(parsed.hosts) ? parsed.hosts : parsed) as Record<string, unknown>;
  const accounts = Array.isArray(hosts[host])
    ? hosts[host]
    : Object.values(hosts).find(Array.isArray);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { authenticated: false, scopes: [] };
  }
  const records = accounts.filter(isRecord);
  const active = records.find((account) => account.active === true) ?? records[0];
  if (!active) {
    return { authenticated: false, scopes: [] };
  }
  const state = typeof active.state === "string" ? active.state : "";
  const login = typeof active.login === "string" ? active.login : undefined;
  const scopes = parseScopeList(active.scopes);
  const tokenSource = normalizeTokenSource(active.tokenSource);
  const gitProtocol = active.gitProtocol === "ssh" || active.gitProtocol === "https"
    ? active.gitProtocol
    : undefined;
  return {
    authenticated: state.toLowerCase() === "success" && Boolean(login),
    ...(login ? { login } : {}),
    scopes,
    ...(tokenSource ? { tokenSource } : {}),
    ...(gitProtocol ? { gitProtocol } : {}),
  };
}

export function accountFromProbe(input: {
  host: string;
  installed: boolean;
  authenticated: boolean;
  repoAccess: boolean;
  login?: string;
  scopes?: string[];
  tokenSource?: GithubAccountSnapshot["tokenSource"];
  gitProtocol?: GithubAccountSnapshot["gitProtocol"];
  repoNameWithOwner?: string;
  remoteAllowed: boolean;
  remoteAccessible: boolean;
  worktreeClean: boolean;
  canPublishBase: boolean;
  error?: string;
}): GithubAccountSnapshot {
  let state: GithubAccountState;
  let detail: string;
  if (!input.installed) {
    state = "missing-cli";
    detail = "未安装 GitHub CLI。安装 gh 后即可在应用内连接 GitHub：https://cli.github.com/";
  } else if (!input.authenticated) {
    state = "logged-out";
    detail = "还没连接 GitHub。点「连接 GitHub」，在打开的浏览器里授权本机 gh。";
  } else if (!input.repoAccess) {
    state = "insufficient";
    detail = "已登录，但这个仓库还没有权限。可点「补授权」或确认有权访问该仓。";
  } else if (input.error) {
    state = "error";
    detail = input.error;
  } else {
    state = "logged-in";
    detail = input.login ? `已连接 ${input.login}@${input.host}` : `已连接 ${input.host}`;
  }
  const canPush =
    state === "logged-in" && input.remoteAccessible && input.remoteAllowed;
  return {
    host: input.host,
    ...(input.login ? { login: input.login } : {}),
    state,
    scopes: input.scopes ?? [],
    ...(input.tokenSource ? { tokenSource: input.tokenSource } : {}),
    ...(input.gitProtocol ? { gitProtocol: input.gitProtocol } : {}),
    ...(input.repoNameWithOwner ? { repoNameWithOwner: input.repoNameWithOwner } : {}),
    canLogin: input.installed,
    canPush,
    canPublish: input.canPublishBase && canPush && input.worktreeClean,
    detail,
  };
}

export function getGithubConnectSession(root: string): GithubConnectView {
  const live = sessions.get(root);
  return live ? { ...live.session } : { status: "idle" };
}

export function startGithubConnect(options: {
  root: string;
  host: string;
  action?: Exclude<GithubConnectAction, "cancel">;
  runner?: GithubProcessRunner;
}): GithubConnectSession {
  const action = options.action ?? "login";
  const existing = sessions.get(options.root);
  if (
    existing &&
    (existing.session.status === "starting" || existing.session.status === "waiting-browser")
  ) {
    return { ...existing.session };
  }

  const session: GithubConnectSession = {
    id: randomUUID(),
    action,
    host: options.host,
    status: "starting",
    startedAt: new Date().toISOString(),
  };
  const abort = new AbortController();
  const live: LiveConnect = {
    session,
    abort,
    done: Promise.resolve(),
  };
  sessions.set(options.root, live);

  const runner = options.runner ?? runProcess;
  const args = action === "refresh" ? githubRefreshArgs(options.host) : githubLoginArgs(options.host);
  live.done = (async () => {
    session.status = "waiting-browser";
    try {
      const result = await runner({
        command: "gh",
        args,
        cwd: options.root,
        timeoutMs: GITHUB_CONNECT_TIMEOUT_MS,
        signal: abort.signal,
      });
      if (result.exitCode === 0) {
        session.status = "succeeded";
      } else {
        session.status = "failed";
        session.error = classifyGithubFailure(
          result.stderr.trim() || result.stdout.trim() || "未完成授权",
        ).message;
      }
    } catch (error) {
      if (abort.signal.aborted) {
        session.status = "cancelled";
        session.error = "已取消连接 GitHub，可再点一次。";
      } else {
        session.status = "failed";
        session.error = classifyGithubFailure(error).message;
      }
    } finally {
      session.finishedAt = new Date().toISOString();
    }
  })();
  return { ...session };
}

export function cancelGithubConnect(root: string): GithubConnectView {
  const live = sessions.get(root);
  if (!live) return { status: "idle" };
  if (live.session.status === "starting" || live.session.status === "waiting-browser") {
    live.abort.abort();
    live.session.status = "cancelled";
    live.session.finishedAt = new Date().toISOString();
    live.session.error = "已取消连接 GitHub，可再点一次。";
  }
  return { ...live.session };
}

export async function waitForGithubConnect(root: string): Promise<GithubConnectView> {
  const live = sessions.get(root);
  if (!live) return { status: "idle" };
  await live.done.catch(() => undefined);
  return { ...live.session };
}

/** Test-only: drop in-memory connect sessions. */
export function resetGithubConnectSessions(): void {
  for (const live of sessions.values()) {
    live.abort.abort();
  }
  sessions.clear();
}

function parseScopeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeTokenSource(value: unknown): GithubAccountSnapshot["tokenSource"] | undefined {
  if (value === "keyring" || value === "env" || value === "plaintext") return value;
  if (typeof value === "string" && value.trim()) return "unknown";
  return undefined;
}

function redactSecretString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/^(ghp_|gho_|ghu_|ghs_|github_pat_)/.test(value)) return "[redacted]";
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
