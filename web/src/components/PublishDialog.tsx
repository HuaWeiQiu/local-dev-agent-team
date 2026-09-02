import { BadgeCheck, FileText, GitPullRequest, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getPublishPreview, publishRun } from "../api";
import { runActionErrorMessage } from "../presentation";
import type { ProjectScope, PublishPreview, RunState } from "../types";

interface PublishDialogProps {
  open: boolean;
  scope?: ProjectScope;
  run?: RunState;
  busy: boolean;
  onClose(): void;
  onPublished(url?: string): void;
}

export function PublishDialog({ open, scope, run, busy, onClose, onPublished }: PublishDialogProps) {
  const [preview, setPreview] = useState<PublishPreview>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [pushBaseBranch, setPushBaseBranch] = useState(false);
  const [formalOverride, setFormalOverride] = useState(false);

  useEffect(() => {
    if (!open || !scope || !run) {
      setPreview(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setPushBaseBranch(false);
    setFormalOverride(false);
    getPublishPreview(scope, run.id)
      .then((next) => {
        if (cancelled) return;
        setPreview(next);
        setTitle(next.title);
        setBody(next.body);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) setError(runActionErrorMessage(requestError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, run, scope]);

  if (!open || !scope || !run) return null;

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await publishRun(scope, run.id, {
        title,
        body,
        ...(pushBaseBranch ? { pushBaseBranch: true } : {}),
        ...(formalOverride ? { draft: false } : {}),
      });
      onPublished(result.pullRequestUrl);
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title">
        <header>
          <div>
            <span className="section-kicker">发布 Pull Request</span>
            <h2 id="publish-dialog-title">{preview?.draft ? "草稿 PR 预览" : "正式 PR 预览"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        {loading && <p className="field-hint">正在生成 PR 预览…</p>}

        {preview && (
          <>
            <div className="publish-branch-row">
              <span><GitPullRequest size={14} />{preview.baseBranch} ← {preview.headBranch}</span>
              {preview.draft
                ? <span className="status-pill is-warn">草稿</span>
                : <span className="status-pill is-ok"><BadgeCheck size={13} />正式</span>}
            </div>
            {!preview.eligible && (
              <p className="policy-notice"><ShieldAlert size={14} />{preview.reason ?? "当前运行不可发布"}</p>
            )}
            {preview.warnings.length > 0 && (
              <ul className="publish-warnings">
                {preview.warnings.map((warning) => <li key={warning}><ShieldAlert size={13} />{warning}</li>)}
              </ul>
            )}
            {preview.draft && preview.eligible && (
              <label className="publish-push-base">
                <input
                  type="checkbox"
                  checked={formalOverride}
                  onChange={(event) => setFormalOverride(event.target.checked)}
                />
                本次创建为正式 PR（仅本次发布，不修改项目配置）
              </label>
            )}
            {!preview.checks.baseOnRemote && preview.eligible && (
              <label className="publish-push-base">
                <input
                  type="checkbox"
                  checked={pushBaseBranch}
                  onChange={(event) => setPushBaseBranch(event.target.checked)}
                />
                同时推送 base 分支 {preview.baseBranch} 到远端（需要确认）
              </label>
            )}

            <label className="field-label" htmlFor="publish-title">PR 标题（≤120 字符）</label>
            <input
              id="publish-title"
              value={title}
              maxLength={120}
              disabled={submitting}
              onChange={(event) => setTitle(event.target.value)}
            />
            <label className="field-label" htmlFor="publish-body">
              <FileText size={14} /> PR 描述（方案 / 执行 / 实现 / 验证）
            </label>
            <textarea
              id="publish-body"
              value={body}
              rows={14}
              maxLength={20_000}
              disabled={submitting}
              onChange={(event) => setBody(event.target.value)}
            />
            {error && <p className="form-error" role="alert">{error}</p>}
            <footer>
              <button type="button" className="button secondary" onClick={onClose} disabled={submitting}>取消</button>
              <button
                type="button"
                className="button primary"
                onClick={() => void submit()}
                disabled={busy || submitting || !preview.eligible || !title.trim()}
              >
                <GitPullRequest size={16} />
                {submitting ? "发布中" : (preview.draft && !formalOverride) ? "创建草稿 PR" : "创建正式 PR"}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
