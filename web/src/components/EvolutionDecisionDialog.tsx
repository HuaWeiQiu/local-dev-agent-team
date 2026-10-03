import { Check, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { EvolutionPreviewMaterial, EvolutionPreviewResponse } from "../types";
import { Modal } from "../ui/dialog";
import { Callout, Field, Textarea } from "../ui/form";
import { ActionButton } from "./evolution/controls";
import { useRestoreFocus } from "./evolution/useRestoreFocus";

export type EvolutionDecision = {
  mode: "promote" | "rollback" | "reject" | "adopt" | "delete";
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
  promote: { description: "人工确认 · 仅对本次修订和当前目标有效。", title: "确认应用候选", action: "确认应用" },
  rollback: { description: "回滚 · 将目标恢复为应用前的精确内容。", title: "确认回滚目标", action: "确认回滚" },
  reject: { description: "人工决定 · 候选将保留为只读审计记录。", title: "拒绝候选", action: "确认拒绝" },
  adopt: { description: "遗留恢复 · 登记已存在的目标内容。", title: "采纳当前目标", action: "确认采纳" },
  delete: { description: "危险操作 · 删除后无法恢复。", title: "删除候选", action: "确认删除" },
} as const;

const formId = "evolution-decision-form";

export function EvolutionDecisionDialog({ decision, busy, error, onClose, onSubmit }: EvolutionDecisionDialogProps) {
  const [reason, setReason] = useState("");
  useRestoreFocus(decision !== undefined);
  useEffect(() => {
    if (decision) setReason("");
    // Reset only when a different command opens, not on every decision object change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.commandId]);

  const copy = dialogCopy[decision?.mode ?? "promote"];
  const preview = decision?.preview;
  const destructive = decision?.mode === "reject" || decision?.mode === "delete";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim()) void onSubmit(reason.trim());
  };

  return (
    <Modal
      open={decision !== undefined}
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      locked={busy}
      title={copy.title}
      description={copy.description}
      className={preview ? "w-[min(960px,calc(100vw-32px))] text-sm" : "w-[min(540px,calc(100vw-32px))] text-sm"}
      footer={
        <>
          <ActionButton onClick={onClose} disabled={busy}>取消</ActionButton>
          <ActionButton type="submit" form={formId} variant={destructive ? "danger" : "primary"} disabled={busy || !reason.trim()}>
            {decision?.mode === "rollback" ? <RotateCcw /> : decision?.mode === "reject" ? <X /> : decision?.mode === "delete" ? <Trash2 /> : <Check />}
            {busy ? "提交中" : decision?.submittedReason !== undefined ? "重试原确认" : copy.action}
          </ActionButton>
        </>
      }
    >
      {decision && (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          {preview ? (
            <>
              <Callout tone="info">以下内容来自服务端精确预览。确认只对本次修订和当前目标有效。</Callout>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="flex min-w-0 items-baseline gap-2 text-xs">
                    <span className="shrink-0 text-muted">变更目标</span>
                    <strong className="min-w-0 truncate font-mono text-xs font-medium text-ink">{preview.description.after.identity}</strong>
                  </div>
                  <div className="flex gap-3 text-2xs tabular-nums text-muted">
                    <span>修订 {preview.preview.catalogRevision}</span>
                    <span>有效至 {new Date(preview.preview.expiresAt).toLocaleTimeString("zh-CN")}</span>
                  </div>
                </div>
                <div className="grid gap-px overflow-hidden rounded-lg bg-[var(--terminal-line)] md:grid-cols-2">
                  <PreviewPane label="当前" material={preview.description.before} />
                  <PreviewPane label={decision.mode === "rollback" ? "回滚后" : "应用后"} material={preview.description.after} />
                </div>
              </div>
            </>
          ) : decision.mode === "adopt" ? (
            <Callout tone="info">仅在当前目标与已晋升候选完全一致时登记现状，不会重新写入内容。</Callout>
          ) : decision.mode === "delete" ? (
            <Callout tone="danger">
              <span className="inline-flex items-start gap-1.5">
                <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                删除后候选从列表与目录中移除，但会保留一条审计墓碑记录（含操作者与原因）；删除不可恢复。
              </span>
            </Callout>
          ) : null}

          <Field label="决定理由" htmlFor="evolution-decision-reason">
            <Textarea
              id="evolution-decision-reason"
              data-autofocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              maxLength={2_000}
              required
              disabled={decision.submittedReason !== undefined}
            />
          </Field>
          {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
        </form>
      )}
    </Modal>
  );
}

function PreviewPane({ label, material }: { label: string; material: EvolutionPreviewMaterial }) {
  const content = material.kind === "role-prompt"
    ? material.content ?? "（目标不存在）"
    : material.definition ? JSON.stringify(material.definition, null, 2) : "（目标不存在）";
  return (
    <section className="flex min-w-0 flex-col bg-[var(--terminal-bg)]">
      <header className="flex h-9 items-center justify-between gap-3 bg-[var(--terminal-raised)] px-3.5">
        <strong className="text-xs font-semibold text-[var(--terminal-ink)]">{label}</strong>
        <span className="font-mono text-2xs text-[var(--terminal-muted)]">{shortDigest(material.digest)}</span>
      </header>
      <pre className="scroll-thin m-0 max-h-72 min-h-40 overflow-auto whitespace-pre-wrap break-words p-3.5 font-mono text-2xs leading-relaxed text-[var(--terminal-ink)] [overflow-wrap:anywhere]">{content}</pre>
    </section>
  );
}

function shortDigest(digest: string | null): string {
  return digest ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : "无摘要";
}
