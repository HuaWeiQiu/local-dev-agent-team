import { GitBranch, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  cleanupTemporaryBranches,
  createBranch,
  createInitialCommit,
  getBranches,
  getGitStatus,
  initializeGit,
  syncBranch,
} from "../api";
import type { BranchInfo, GitEnvironmentStatus, ProjectScope } from "../types";
import { ChangesPanel } from "./ChangesPanel";
import { GithubConnectBar } from "./GithubConnectBar";

interface ProjectGitPanelProps {
  scope: ProjectScope;
  configDefaultBranch: string;
}

export function ProjectGitPanel({ scope, configDefaultBranch }: ProjectGitPanelProps) {
  const [status, setStatus] = useState<GitEnvironmentStatus>();
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [newName, setNewName] = useState("");
  const [newBase, setNewBase] = useState("");
  const [syncFirst, setSyncFirst] = useState(true);
  const [showTemporary, setShowTemporary] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextStatus, nextBranches] = await Promise.all([
        getGitStatus(scope),
        getBranches(scope, "all"),
      ]);
      setStatus(nextStatus);
      setBranches(nextBranches);
      setNewBase((current) =>
        current || nextStatus.remoteDefaultBranch || nextStatus.localDefaultBranch || configDefaultBranch,
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  }, [configDefaultBranch, scope]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runAction = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      setMessage(await action());
      await reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const defaultBranch = status?.remoteDefaultBranch ?? status?.localDefaultBranch ?? configDefaultBranch;
  const localBranches = branches.filter((branch) => branch.kind === "local");
  const visibleBranches = showTemporary ? branches : branches.filter((branch) => !branch.temporary);
  const temporaryCount = branches.filter((branch) => branch.temporary).length;

  return (
    <section className="settings-panel" aria-label="项目 Git">
      <div className="settings-panel-head">
        <GitBranch size={18} />
        <div>
          <h2>Git 分支</h2>
          <small>选择/新建/同步远端默认分支；不改主工作区当前 checkout</small>
        </div>
        <button type="button" className="button secondary" onClick={() => void reload()} disabled={loading || busy}>
          <RefreshCw size={14} />{loading ? "检测中" : "刷新"}
        </button>
      </div>

      {status && (
        <div className="git-capability-row">
          <span className={`git-capability ${status.gitInstalled ? "is-ok" : "is-bad"}`}>
            {status.gitInstalled ? "✓" : "!"} git{status.gitVersion ? ` ${status.gitVersion}` : ""}
          </span>
          <span className={`git-capability ${status.isRepository && status.repoRootMatches ? "is-ok" : "is-bad"}`}>
            {status.isRepository ? "✓ 仓库" : "! 非仓库"}
          </span>
          <span className={`git-capability ${status.worktreeClean ? "is-ok" : "is-bad"}`}>
            {status.worktreeClean ? "✓ 干净" : "! 有改动"}
          </span>
          <span className={`git-capability ${status.ghAuthenticated && status.ghRepoAccess ? "is-ok" : "is-bad"}`}>
            {status.ghAuthenticated ? "✓ gh" : "! gh 未就绪"}
          </span>
          <span className="git-default-note">
            默认分支：{defaultBranch}
            {status.remoteOwner ? ` · ${status.remoteOwner}` : ""}
            {status.remoteDefaultBranch && status.remoteDefaultBranch !== configDefaultBranch
              ? `（配置为 ${configDefaultBranch}，以远端为准）`
              : ""}
          </span>
        </div>
      )}
      {status && (
        <GithubConnectBar
          scope={scope}
          account={status.githubAccount}
          disabled={busy}
          onChanged={reload}
        />
      )}
      {status?.isRepository && status.repoRootMatches && (
        <ChangesPanel scope={scope} status={status} disabled={busy} onChanged={reload} />
      )}

      {status?.blockers.filter((blocker) => blocker !== "dirty-worktree" && blocker !== "gh-not-authenticated" && blocker !== "gh-missing" && blocker !== "gh-no-repo-access").length ? (
        <p className="policy-notice"><ShieldAlert size={14} />{status.blockers.map(blockerHint).filter(Boolean).join("；")}</p>
      ) : null}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="field-hint">{message}</p>}

      {status?.gitInstalled && !status.isRepository && (
        <button type="button" className="button secondary" disabled={busy} onClick={() => void runAction(async () => {
          await initializeGit(scope);
          return "已初始化 Git 仓库";
        })}>
          初始化 Git 仓库（{configDefaultBranch}）
        </button>
      )}
      {status?.isRepository && !status.hasCommits && (
        <button type="button" className="button secondary" disabled={busy} onClick={() => void runAction(async () => {
          const result = await createInitialCommit(scope);
          return `已创建空初始提交 ${result.commit.slice(0, 8)}`;
        })}>
          创建空初始提交
        </button>
      )}

      <div className="git-panel-actions">
        <label>
          <input type="checkbox" checked={showTemporary} onChange={(event) => setShowTemporary(event.target.checked)} />
          显示 Agent 临时分支{temporaryCount ? `（${temporaryCount}）` : ""}
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={busy || temporaryCount === 0 || !status?.worktreeClean}
          title={!status?.worktreeClean ? "主工作区不干净时不能批量删分支" : "只删除 agent-team/ 临时分支，不动 main/feature"}
          onClick={() => void runAction(async () => {
            const result = await cleanupTemporaryBranches(scope);
            return `已删除 ${result.deleted.length} 个临时分支${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ""}`;
          })}
        >
          清理临时分支
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || !status?.canSync}
          title={status && !status.canSync ? (status.dirtyReason ?? "当前还不能同步远端默认分支") : "ff-only 同步远端默认分支"}
          onClick={() => void runAction(async () => {
            const result = await syncBranch(scope, {});
            return result.changed
              ? `已同步 ${result.branch} → ${result.newCommit.slice(0, 8)}`
              : `${result.branch} 已是最新`;
          })}
        >
          <RefreshCw size={14} />同步远端默认分支
        </button>
      </div>

      <div className="git-create-row">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="feature/your-branch"
          disabled={busy}
          aria-label="新分支名"
        />
        <select value={newBase} onChange={(event) => setNewBase(event.target.value)} disabled={busy} aria-label="基地分支">
          {localBranches.length === 0 && <option value={defaultBranch}>{defaultBranch}</option>}
          {localBranches.map((branch) => (
            <option key={branch.name} value={branch.name}>
              {branch.name}{branch.isDefault ? " · 默认" : ""}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={syncFirst} onChange={(event) => setSyncFirst(event.target.checked)} />
          先同步
        </label>
        <button
          type="button"
          className="button primary"
          disabled={busy || !newName.trim()}
          onClick={() => void runAction(async () => {
            const branch = await createBranch(scope, {
              name: newName.trim(),
              ...(newBase ? { baseBranch: newBase } : {}),
              syncFirst,
            });
            setNewName("");
            return `已创建 ${branch.name} @ ${branch.commit.slice(0, 8)}`;
          })}
        >
          <Plus size={14} />创建分支
        </button>
      </div>

      <div className="git-branch-table" role="table" aria-label="分支列表">
        {visibleBranches.length === 0 && <p className="muted">{temporaryCount > 0 ? "日常分支已隐藏 Agent 临时分支" : "暂无分支"}</p>}
        {visibleBranches.map((branch) => (
          <div key={`${branch.kind}:${branch.name}`} className="git-branch-row" role="row">
            <code>{branch.name}</code>
            <span>{branch.kind === "remote" ? "远端" : "本地"}</span>
            <span>{branch.commit.slice(0, 8)}</span>
            {branch.isDefault ? <span className="status-pill is-ok">默认</span> : <span />}
            {branch.isCurrent ? <span>当前</span> : <span />}
          </div>
        ))}
      </div>
    </section>
  );
}

function blockerHint(blocker: string): string {
  const map: Record<string, string> = {
    "git-missing": "未检测到 Git",
    "not-a-repository": "还不是 Git 仓库",
    "root-mismatch": "配置目录与仓库根不一致",
    "dirty-worktree": "主工作区有未提交改动",
    "no-commits": "仓库还没有提交",
    "no-remote": "未配置远端",
    "remote-unreachable": "远端不可达",
    "gh-missing": "未安装 GitHub CLI",
    "gh-not-authenticated": "还没连接 GitHub",
    "gh-no-repo-access": "gh 没有仓库权限",
    "remote-not-allowed": "远端不在企业仓库白名单",
  };
  return map[blocker] ?? blocker;
}
