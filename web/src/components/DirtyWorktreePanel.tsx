import { FileDiff, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { getWorktreeDiff, stashWorktree } from "../api";
import type { GitEnvironmentStatus, ProjectScope } from "../types";

interface DirtyWorktreePanelProps {
  scope: ProjectScope;
  status: GitEnvironmentStatus;
  disabled?: boolean;
  onChanged(): Promise<void> | void;
}

export function DirtyWorktreePanel({
  scope,
  status,
  disabled,
  onChanged,
}: DirtyWorktreePanelProps) {
  const [diff, setDiff] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (status.worktreeClean || status.blockers.includes("not-a-repository")) {
    return null;
  }

  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await action();
      if (next !== undefined) setDiff(next);
      await onChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dirty-worktree-panel" role="status">
      <p className="policy-notice">
        <ShieldAlert size={14} />
        {status.dirtyReason ?? "主工作区有未提交改动，同步和开跑前需要先处理。可到项目 Git 的 Changes 里勾选提交，或先暂存。"}
      </p>
      {status.dirtyFiles.length > 0 && (
        <ul className="dirty-file-list">
          {status.dirtyFiles.slice(0, 12).map((file) => (
            <li key={file.path}>
              <span className={`dirty-origin is-${file.origin}`}>{file.origin === "agent" ? "Agent" : "本地"}</span>
              <span>{file.status}</span>
              <code>{file.path}</code>
            </li>
          ))}
        </ul>
      )}
      {status.dirtyFiles.length > 12 && (
        <p className="field-hint">还有 {status.dirtyFiles.length - 12} 个文件未列出。</p>
      )}
      <div className="dirty-actions">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || busy}
          onClick={() => void run(async () => (await getWorktreeDiff(scope)).content || "没有可显示的 diff。")}
        >
          <FileDiff size={14} />查看改动
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || busy}
          onClick={() => void run(async () => {
            const result = await stashWorktree(scope);
            return result.created ? undefined : "没有可暂存的改动";
          })}
        >
          先帮我收好
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || busy}
          onClick={() => void run(async () => undefined)}
        >
          <RefreshCw size={14} />刷新
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {diff !== undefined && <pre className="dirty-diff">{diff || "没有可显示的 diff。"}</pre>}
    </div>
  );
}
