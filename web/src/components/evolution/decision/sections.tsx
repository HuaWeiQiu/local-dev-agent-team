import { ShieldCheck } from "lucide-react";
import type { EvolutionPreviewMaterial, EvolutionPreviewResponse } from "../../../types";
import type { EvolutionDecision } from "../../EvolutionDecisionDialog";
import { Callout } from "../../../ui/form";

export function PreviewNotice() {
  return (
    <Callout tone="info">以下内容来自服务端精确预览。确认只对本次修订和当前目标有效。</Callout>
  );
}

export function PreviewPanes({
  decision,
  preview,
}: {
  decision: EvolutionDecision;
  preview: EvolutionPreviewResponse;
}) {
  return (
    <div className="flex flex-col gap-2">
      <PreviewHeader preview={preview} />
      <div className="grid gap-px overflow-hidden rounded-lg bg-[var(--terminal-line)] md:grid-cols-2">
        <PreviewPane label="当前" material={preview.description.before} />
        <PreviewPane
          label={decision.mode === "rollback" ? "回滚后" : "应用后"}
          material={preview.description.after}
        />
      </div>
    </div>
  );
}

function PreviewHeader({ preview }: { preview: EvolutionPreviewResponse }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="shrink-0 text-muted">变更目标</span>
        <strong className="min-w-0 truncate font-mono text-xs font-medium text-ink">
          {preview.description.after.identity}
        </strong>
      </div>
      <div className="flex gap-3 text-2xs tabular-nums text-muted">
        <span>修订 {preview.preview.catalogRevision}</span>
        <span>有效至 {new Date(preview.preview.expiresAt).toLocaleTimeString("zh-CN")}</span>
      </div>
    </div>
  );
}

export function AdoptNotice() {
  return (
    <Callout tone="info">仅在当前目标与已晋升候选完全一致时登记现状，不会重新写入内容。</Callout>
  );
}

export function DeleteNotice() {
  return (
    <Callout tone="danger">
      <span className="inline-flex items-start gap-1.5">
        <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        删除后候选从列表与目录中移除，但会保留一条审计墓碑记录（含操作者与原因）；删除不可恢复。
      </span>
    </Callout>
  );
}

function PreviewPane({ label, material }: { label: string; material: EvolutionPreviewMaterial }) {
  return (
    <section className="flex min-w-0 flex-col bg-[var(--terminal-bg)]">
      <header className="flex h-9 items-center justify-between gap-3 bg-[var(--terminal-raised)] px-3.5">
        <strong className="text-xs font-semibold text-[var(--terminal-ink)]">{label}</strong>
        <span className="font-mono text-2xs text-[var(--terminal-muted)]">
          {shortDigest(material.digest)}
        </span>
      </header>
      <pre className="scroll-thin m-0 max-h-72 min-h-40 overflow-auto whitespace-pre-wrap break-words p-3.5 font-mono text-2xs leading-relaxed text-[var(--terminal-ink)] [overflow-wrap:anywhere]">
        {materialContent(material)}
      </pre>
    </section>
  );
}

function materialContent(material: EvolutionPreviewMaterial): string {
  if (material.kind === "role-prompt") return material.content ?? "（目标不存在）";
  return material.definition ? JSON.stringify(material.definition, null, 2) : "（目标不存在）";
}

export function shortDigest(digest: string | null): string {
  return digest ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : "无摘要";
}
