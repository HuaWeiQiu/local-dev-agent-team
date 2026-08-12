import { Check, History, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { ApprovalRequest } from "../types";

interface RunActionDialogProps {
  mode: "approval" | "resume" | undefined;
  approval?: ApprovalRequest;
  busy: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: {
    decision?: "approved" | "rejected";
    actor: string;
    reason: string;
  }): Promise<void>;
}

export function RunActionDialog({
  mode,
  approval,
  busy,
  error,
  onClose,
  onSubmit,
}: RunActionDialogProps) {
  const [actor, setActor] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (mode) {
      setActor("");
      setReason("");
    }
  }, [mode]);

  if (!mode) return null;

  const execute = async (decision?: "approved" | "rejected") => {
    if (!actor.trim() || !reason.trim()) return;
    await onSubmit({
      ...(decision ? { decision } : {}),
      actor: actor.trim(),
      reason: reason.trim(),
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void execute(mode === "approval" ? "approved" : undefined);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="run-action-dialog" role="dialog" aria-modal="true" aria-labelledby="run-action-title">
        <header>
          <div>
            <span className="section-kicker">{mode === "approval" ? "人工门禁" : "检查点"}</span>
            <h2 id="run-action-title">
              {mode === "approval" ? (approval?.gate === "plan" ? "审批执行计划" : "审批交付结果") : "恢复运行"}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={submit}>
          {approval && (
            <div className="approval-summary">
              <strong>{approval.summary}</strong>
              <span>截止 {new Date(approval.expiresAt).toLocaleString("zh-CN")}</span>
            </div>
          )}
          <label className="field-label" htmlFor="action-actor">操作者</label>
          <input
            id="action-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            maxLength={200}
            autoFocus
            required
          />
          <label className="field-label" htmlFor="action-reason">理由</label>
          <textarea
            id="action-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            maxLength={2_000}
            required
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="button secondary" onClick={onClose}>取消</button>
            {mode === "approval" && (
              <button
                type="button"
                className="button danger-quiet"
                disabled={busy || !actor.trim() || !reason.trim()}
                onClick={() => void execute("rejected")}
              >
                <X size={16} />拒绝
              </button>
            )}
            <button type="submit" className="button primary" disabled={busy || !actor.trim() || !reason.trim()}>
              {mode === "approval" ? <Check size={16} /> : <History size={16} />}
              {busy ? "提交中" : mode === "approval" ? "批准" : "恢复"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
