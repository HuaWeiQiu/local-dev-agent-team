import { Check, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { EvolutionPreviewMaterial, EvolutionPreviewResponse } from "../types";
import { useModalKeyboard } from "../useModalKeyboard";

export type EvolutionDecision = {
  mode: "promote" | "rollback" | "reject" | "adopt";
  proposalId: string;
  commandId: string;
  preview?: EvolutionPreviewResponse;
  submittedReason?: string;
};

interface EvolutionDecisionDialogProps {
  decision: EvolutionDecision | undefined;
  busy: boolean;
  error?: string;
  onClose(): void;
  onSubmit(reason: string): Promise<void>;
}

const dialogCopy = {
  promote: { kicker: "人工确认", title: "确认应用候选", action: "确认应用" },
  rollback: { kicker: "回滚", title: "确认回滚目标", action: "确认回滚" },
  reject: { kicker: "人工决定", title: "拒绝候选", action: "确认拒绝" },
  adopt: { kicker: "遗留恢复", title: "采纳当前目标", action: "确认采纳" },
} as const;

export function EvolutionDecisionDialog({ decision, busy, error, onClose, onSubmit }: EvolutionDecisionDialogProps) {
  const [reason, setReason] = useState("");
  const dialogRef = useModalKeyboard(Boolean(decision), busy, onClose);
  useEffect(() => {
    if (decision) setReason("");
  }, [decision?.commandId]);
  if (!decision) return null;
  const copy = dialogCopy[decision.mode];
  const preview = decision.preview;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim()) void onSubmit(reason.trim());
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="evolution-decision-dialog" role="dialog" aria-modal="true" aria-labelledby="evolution-decision-title" tabIndex={-1}>
        <header>
          <div><span className="section-kicker">{copy.kicker}</span><h2 id="evolution-decision-title">{copy.title}</h2></div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <form onSubmit={submit}>
          {preview ? (
            <>
              <p className="evolution-preview-policy"><ShieldCheck size={15} />以下内容来自服务端精确预览。确认只对本次修订和当前目标有效。</p>
              <div className="evolution-preview-target"><span>变更目标</span><strong>{preview.description.after.identity}</strong></div>
              <div className="evolution-preview-grid">
                <PreviewPane label="当前" material={preview.description.before} />
                <PreviewPane label={decision.mode === "rollback" ? "回滚后" : "应用后"} material={preview.description.after} />
              </div>
              <div className="evolution-preview-meta"><span>修订 {preview.preview.catalogRevision}</span><span>有效至 {new Date(preview.preview.expiresAt).toLocaleTimeString("zh-CN")}</span></div>
            </>
          ) : decision.mode === "adopt" ? (
            <p className="evolution-preview-policy"><ShieldCheck size={15} />仅在当前目标与已晋升候选完全一致时登记现状，不会重新写入内容。</p>
          ) : null}
          <label className="field-label" htmlFor="evolution-decision-reason">决定理由</label>
          <textarea id="evolution-decision-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={4} maxLength={2_000} autoFocus required disabled={decision.submittedReason !== undefined} />
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className={decision.mode === "reject" ? "button danger-quiet" : "button primary"} disabled={busy || !reason.trim()}>
              {decision.mode === "rollback" ? <RotateCcw size={16} /> : decision.mode === "reject" ? <X size={16} /> : <Check size={16} />}
              {busy ? "提交中" : decision.submittedReason !== undefined ? "重试原确认" : copy.action}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function PreviewPane({ label, material }: { label: string; material: EvolutionPreviewMaterial }) {
  const content = material.kind === "role-prompt"
    ? material.content ?? "（目标不存在）"
    : material.definition ? JSON.stringify(material.definition, null, 2) : "（目标不存在）";
  return (
    <section>
      <header><strong>{label}</strong><span>{shortDigest(material.digest)}</span></header>
      <pre>{content}</pre>
    </section>
  );
}

function shortDigest(digest: string | null): string {
  return digest ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : "无摘要";
}
