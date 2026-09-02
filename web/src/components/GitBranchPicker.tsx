import { GitBranch, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getBranches, getGitStatus, initializeGit, createInitialCommit, syncBranch } from "../api";
import { summarizeGoal } from "../presentation";
import type { BranchInfo, GitEnvironmentStatus, ProjectScope } from "../types";
import { DirtyWorktreePanel } from "./DirtyWorktreePanel";
import { GithubConnectBar } from "./GithubConnectBar";

export interface GitSelection {
  baseBranch?: string;
  headBranchName?: string;
  syncDefaultFirst?: boolean;
  stashIfDirty?: boolean;
}

interface GitBranchPickerProps {
  scope?: ProjectScope | undefined;
  goal: string;
  configDefaultBranch: string;
  disabled: boolean;
  onChange(selection: GitSelection): void;
}

const branchPrefixes = ["feature", "fix", "chore", "docs", "refactor"] as const;

export function GitBranchPicker({
  scope,
  goal,
  configDefaultBranch,
  disabled,
  onChange,
}: GitBranchPickerProps) {
  const [status, setStatus] = useState<GitEnvironmentStatus>();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [initBusy, setInitBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [baseBranch, setBaseBranch] = useState("");
  const [customHead, setCustomHead] = useState(false);
  const [prefix, setPrefix] = useState<string>("feature");
  const [syncDefaultFirst, setSyncDefaultFirst] = useState(true);
  const [stashIfDirty, setStashIfDirty] = useState(true);

  const defaultBranch = useMemo(
    () => status?.remoteDefaultBranch ?? status?.localDefaultBranch ?? configDefaultBranch,
    [configDefaultBranch, status],
  );

  const headBranchName = useMemo(() => {
    if (!customHead) return undefined;
    const existing = new Set(branches.map((branch) => branch.name));
    return suggestGoalBranchName(goal, prefix, existing);
  }, [branches, customHead, goal, prefix]);

  useEffect(() => {
    onChange({
      ...(baseBranch ? { baseBranch } : {}),
      ...(customHead && headBranchName ? { headBranchName } : {}),
      ...(customHead && syncDefaultFirst ? { syncDefaultFirst: true } : {}),
      ...(stashIfDirty ? { stashIfDirty: true } : {}),
    });
  }, [baseBranch, customHead, headBranchName, onChange, stashIfDirty, syncDefaultFirst]);

  useEffect(() => {
    if (!scope || status) return;
    void load(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    setBaseBranch((current) => current || defaultBranch);
  }, [defaultBranch]);

  async function load(targetScope: ProjectScope, refreshStatus = false) {
    setLoading(true);
    setError(undefined);
    try {
      const [nextStatus, nextBranches] = await Promise.all([
        refreshStatus || !status ? getGitStatus(targetScope) : Promise.resolve(status!),
        getBranches(targetScope, "all"),
      ]);
      setStatus(nextStatus);
      setBranches(nextBranches);
      setBaseBranch((current) => current || nextStatus.remoteDefaultBranch || nextStatus.localDefaultBranch || configDefaultBranch);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  const sync = async () => {
    if (!scope) return;
    setSyncBusy(true);
    setError(undefined);
    try {
      await syncBranch(scope, {});
      setStatus(undefined);
      await load(scope, true);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSyncBusy(false);
    }
  };

  const initRepo = async () => {
    if (!scope) return;
    setInitBusy(true);
    setError(undefined);
    try {
      await initializeGit(scope);
      setStatus(undefined);
      await load(scope, true);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setInitBusy(false);
    }
  };

  const initialCommit = async () => {
    if (!scope) return;
    setInitBusy(true);
    setError(undefined);
    try {
      await createInitialCommit(scope);
      setStatus(undefined);
      await load(scope, true);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setInitBusy(false);
    }
  };

  const blockers = status?.blockers ?? [];

  return (
    <fieldset className="git-branch-fieldset">
      <legend><GitBranch size={15} /> Git 分支</legend>
      {loading && !status && <p className="field-hint">正在检测 Git 环境…</p>}
      {status && (
        <div className="git-capability-row">
          <Capability label="git" ok={status.gitInstalled} detail={status.gitVersion} />
          <Capability label="仓库" ok={status.isRepository && status.repoRootMatches} detail={status.worktreeClean ? "干净" : "有改动"} />
          <Capability label="gh" ok={status.ghAuthenticated && status.ghRepoAccess} detail={status.githubAccount?.login ?? (status.ghAuthenticated ? "已授权" : "未连接")} />
          {status.remoteDefaultBranch && status.remoteDefaultBranch !== configDefaultBranch && (
            <span className="git-default-note">
              远端默认分支：{status.remoteDefaultBranch}
            </span>
          )}
        </div>
      )}

      {scope && (
        <GithubConnectBar
          scope={scope}
          account={status?.githubAccount}
          disabled={disabled || initBusy}
          onChanged={() => load(scope, true)}
        />
      )}
      {scope && status && !status.worktreeClean ? (
        <DirtyWorktreePanel
          scope={scope}
          status={status}
          disabled={disabled || initBusy}
          onChanged={() => load(scope, true)}
        />
      ) : blockers.length > 0 ? (
        <p className="policy-notice">
          <ShieldAlert size={14} />
          {blockerHint(blockers)}
        </p>
      ) : null}
      {status?.gitInstalled && !status.isRepository && (
        <button type="button" className="button secondary" onClick={() => void initRepo()} disabled={disabled || initBusy}>
          初始化 Git 仓库（{configDefaultBranch}）
        </button>
      )}
      {status?.isRepository && status.repoRootMatches && !status.hasCommits && (
        <button type="button" className="button secondary" onClick={() => void initialCommit()} disabled={disabled || initBusy}>
          创建空初始提交
        </button>
      )}

      <div className="git-branch-grid">
        <label className="field-label" htmlFor="git-base-branch">base（PR 目标分支）</label>
        <select
          id="git-base-branch"
          value={baseBranch}
          disabled={disabled || loading || branches.length === 0}
          onChange={(event) => setBaseBranch(event.target.value)}
        >
          {branches.length === 0 && <option value="">{status?.remoteConfigured ? "暂无可选分支" : "无远端分支（使用配置默认分支）"}</option>}
          {branches.map((branch) => (
            <option key={`${branch.kind}:${branch.name}`} value={branch.name}>
              {branch.name}
              {branch.kind === "remote" ? "（远端）" : ""}
              {branch.isDefault ? " · 默认" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button secondary compact"
          onClick={() => void sync()}
          disabled={disabled || syncBusy || !status?.canSync}
          title={status && !status.canSync ? (status.dirtyReason ?? "当前还不能同步远端默认分支") : "ff-only 同步远端默认分支"}
        >
          <RefreshCw size={14} />{syncBusy ? "同步中" : "同步远端默认分支"}
        </button>

        <label className="git-head-mode">
          <input
            type="checkbox"
            checked={customHead}
            disabled={disabled || !status?.canSync}
            onChange={(event) => setCustomHead(event.target.checked)}
          />
          <span>按目标创建工作分支（推荐新功能）</span>
        </label>
        {customHead && (
          <div className="git-head-branch-row">
            <select
              value={prefix}
              disabled={disabled}
              onChange={(event) => setPrefix(event.target.value)}
              aria-label="分支前缀"
            >
              {branchPrefixes.map((item) => <option key={item} value={item}>{item}/</option>)}
            </select>
            <code title={headBranchName}>{headBranchName ?? "…"}</code>
            <label className="git-sync-first">
              <input
                type="checkbox"
                checked={syncDefaultFirst}
                disabled={disabled || !status?.canSync}
                onChange={(event) => setSyncDefaultFirst(event.target.checked)}
              />
              先同步远端默认分支再以其为基地
            </label>
            {status && !status.worktreeClean ? (
              <label className="git-sync-first">
                <input
                  type="checkbox"
                  checked={stashIfDirty}
                  disabled={disabled}
                  onChange={(event) => setStashIfDirty(event.target.checked)}
                />
                工作区不干净就先帮我收好再开跑
              </label>
            ) : null}
          </div>
        )}
        {!customHead && (
          <p className="field-hint">
            保持关闭时使用内部工作分支 agent-team/…；PR 仍指向所选 base。
          </p>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </fieldset>
  );
}

function Capability({ label, ok, detail }: { label: string; ok: boolean; detail?: string | undefined }) {
  return (
    <span className={`git-capability ${ok ? "is-ok" : "is-bad"}`} title={detail ?? label}>
      {ok ? "✓" : "!"} {label}{detail ? ` ${detail}` : ""}
    </span>
  );
}

function blockerHint(blockers: string[]): string {
  const map: Record<string, string> = {
    "git-missing": "未检测到 Git，请安装后重试",
    "not-a-repository": "当前目录不是 Git 仓库，请先 git init",
    "root-mismatch": "配置目录与 Git 仓库根目录不一致",
    "dirty-worktree": "主工作区有未提交改动，无法启动",
    "no-commits": "仓库还没有提交，无法创建分支",
    "no-remote": "未配置远端仓库，无法同步或发布",
    "remote-unreachable": "远端仓库不可达",
    "gh-missing": "未安装 GitHub CLI，无法发布 PR",
    "gh-not-authenticated": "还没连接 GitHub，无法发布 PR",
    "gh-no-repo-access": "gh 账号没有该仓库权限",
    "remote-not-allowed": "远端不在企业仓库白名单",
  };
  return blockers.map((blocker) => map[blocker]).filter(Boolean).join("；");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function suggestGoalBranchName(
  goal: string,
  prefix = "feature",
  existing: Iterable<string> = [],
): string {
  const slug = summarizeGoal(goal, 48)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "goal";
  const known = new Set(existing);
  let candidate = `${prefix}/${slug}`;
  for (let attempt = 2; known.has(candidate); attempt += 1) {
    candidate = `${prefix}/${slug}-${attempt}`;
  }
  return candidate;
}
