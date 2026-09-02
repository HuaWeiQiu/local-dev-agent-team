import { FileDiff, GitCommitHorizontal, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { commitGitPaths, getGitChanges, getWorktreeDiff, pushCurrentBranch, stashWorktree } from "../api";
import type { GitChangeFile, GitChangesSnapshot, GitEnvironmentStatus, ProjectScope } from "../types";

interface ChangesPanelProps {
  scope: ProjectScope;
  status?: GitEnvironmentStatus;
  disabled?: boolean;
  onChanged(): Promise<void> | void;
}

export function ChangesPanel({ scope, status, disabled, onChanged }: ChangesPanelProps) {
  const [snapshot, setSnapshot] = useState<GitChangesSnapshot>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [diffPath, setDiffPath] = useState<string>();
  const [diff, setDiff] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();

  const reload = async () => {
    const next = await getGitChanges(scope);
    setSnapshot(next);
    setSelected((current) => {
      if (current.size === 0) {
        return new Set(next.files.filter((file) => file.origin === "user" && !isConflict(file)).map((file) => file.path));
      }
      const allowed = new Set(next.files.map((file) => file.path));
      return new Set([...current].filter((path) => allowed.has(path)));
    });
  };

  useEffect(() => {
    void reload().catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.projectId, status?.worktreeClean, status?.changeSummary?.files]);

  const files = snapshot?.files ?? [];
  const selectedFiles = useMemo(() => files.filter((file) => selected.has(file.path)), [files, selected]);
  const connected = status?.githubAccount?.state === "logged-in";
  const canCommit = Boolean(snapshot?.canCommit && selectedFiles.length > 0 && message.trim());
  const canPushOnly = Boolean(snapshot && snapshot.canPush && snapshot.ahead > 0 && selectedFiles.length === 0);
  const canCommitAndPush = Boolean(canCommit && snapshot?.canPush && snapshot.behind === 0 && connected);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      setInfo(await action());
      await reload();
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="changes-panel" aria-label="Changes">
      <div className="changes-head">
        <strong>Changes</strong>
        <span className="changes-branch">{snapshot?.branch ?? status?.currentBranch ?? "未检测"}</span>
        <span className="changes-stat is-plus">+{snapshot?.insertions ?? status?.changeSummary?.insertions ?? 0}</span>
        <span className="changes-stat is-minus">-{snapshot?.deletions ?? status?.changeSummary?.deletions ?? 0}</span>
        {(snapshot?.ahead ?? 0) > 0 && <span className="changes-ahead">↑{snapshot?.ahead}</span>}
        {(snapshot?.behind ?? 0) > 0 && <span className="changes-behind">↓{snapshot?.behind}</span>}
      </div>

      {files.length === 0 ? (
        <p className="muted">主工作区是干净的，没有未提交改动。</p>
      ) : (
        <>
          <label className="changes-select-all">
            <input
              type="checkbox"
              checked={selectedFiles.length > 0 && selectedFiles.length === files.filter((file) => !isConflict(file)).length}
              onChange={(event) => {
                setSelected(event.target.checked
                  ? new Set(files.filter((file) => !isConflict(file)).map((file) => file.path))
                  : new Set());
              }}
            />
            全选
          </label>
          <ul className="changes-file-list">
            {files.map((file) => {
              const conflict = isConflict(file);
              return (
                <li key={file.path} className={conflict ? "is-conflict" : undefined}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(file.path)}
                      disabled={conflict}
                      onChange={(event) => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(file.path);
                          else next.delete(file.path);
                          return next;
                        });
                      }}
                    />
                    <span className={`changes-xy is-${file.untracked ? "new" : "mod"}`}>
                      {file.untracked ? "New" : shortStatus(file)}
                    </span>
                    <button
                      type="button"
                      className="changes-path"
                      onClick={() => void toggleDiff(file.path)}
                    >
                      {file.path}
                    </button>
                    {file.origin === "agent" && <span className="dirty-origin is-agent">Agent</span>}
                    <span className="changes-stat is-plus">+{file.insertions}</span>
                    <span className="changes-stat is-minus">-{file.deletions}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {diffPath && (
        <pre className="dirty-diff" aria-label={`${diffPath} 的改动`}>
          {diff ?? "正在加载 diff…"}
        </pre>
      )}

      {!snapshot?.identityConfigured && snapshot?.identityReason && (
        <p className="policy-notice">{snapshot.identityReason}</p>
      )}
      {(snapshot?.behind ?? 0) > 0 && (
        <p className="field-hint">远端超前 {snapshot?.behind} 个提交，推送已禁用。请先同步默认分支。</p>
      )}
      {!connected && (
        <p className="field-hint">还没连接 GitHub，可以先提交到本地，连上后再 Push。</p>
      )}

      <div className="changes-commit-row">
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="提交说明"
          disabled={busy || disabled || files.length === 0}
          aria-label="提交说明"
        />
        <button
          type="button"
          className="button secondary"
          disabled={busy || disabled || !canCommit}
          onClick={() => void run(async () => {
            const result = await commitGitPaths(scope, { message: message.trim(), paths: [...selected] });
            setMessage("");
            return `已提交 ${result.commit.slice(0, 8)}（${result.files.length} 个文件）`;
          })}
        >
          <GitCommitHorizontal size={14} />Commit
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || disabled || !(canCommitAndPush || canPushOnly)}
          title={!connected ? "先连接 GitHub 再推送" : snapshot && snapshot.behind > 0 ? "远端有未拉取提交" : "推送当前分支，不会 force-push"}
          onClick={() => void run(async () => {
            if (selectedFiles.length > 0) {
              await commitGitPaths(scope, { message: message.trim(), paths: [...selected] });
              setMessage("");
            }
            const pushed = await pushCurrentBranch(scope);
            return `已推送 ${pushed.branch} @ ${pushed.commit.slice(0, 8)}`;
          })}
        >
          <Upload size={14} />
          {canPushOnly ? `Push ↑${snapshot?.ahead}` : "Commit & Push"}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || disabled || files.length === 0}
          onClick={() => void run(async () => {
            const result = await stashWorktree(scope);
            return result.created ? "已把未提交改动暂存起来" : "没有可暂存的改动";
          })}
        >
          先帮我收好
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || disabled}
          onClick={() => void run(async () => "已刷新")}
        >
          <FileDiff size={14} />刷新
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {info && <p className="field-hint">{info}</p>}
    </section>
  );

  async function toggleDiff(filePath: string) {
    if (diffPath === filePath) {
      setDiffPath(undefined);
      setDiff(undefined);
      return;
    }
    setDiffPath(filePath);
    setDiff(undefined);
    try {
      const next = await getWorktreeDiff(scope, filePath);
      setDiff(next.content || "没有可显示的 diff。");
    } catch (requestError) {
      setDiff(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }
}

function isConflict(file: GitChangeFile): boolean {
  return file.xy.includes("U") || file.xy === "DD" || file.xy === "AA";
}

function shortStatus(file: GitChangeFile): string {
  if (file.xy.includes("D")) return "D";
  if (file.xy.includes("R")) return "R";
  if (file.untracked) return "New";
  return "M";
}
