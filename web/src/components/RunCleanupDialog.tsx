import { AlertTriangle, ArchiveX, Clock3, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes } from "../presentation";
import type { RunCleanupPreview } from "../types";
import { RunStatusBadge } from "./StatusBadge";

interface RunCleanupDialogProps {
  open: boolean;
  preview: RunCleanupPreview | undefined;
  busy: boolean;
  error: string | undefined;
  onPreview(days: number): Promise<void>;
  onConfirm(): Promise<void>;
  onResetPreview(): void;
  onClose(): void;
}

export function RunCleanupDialog({ open, preview, busy, error, onPreview, onConfirm, onResetPreview, onClose }: RunCleanupDialogProps) {
  const [days, setDays] = useState(30);
  useEffect(() => {
    if (!open) setDays(30);
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="run-cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
        <header>
          <div><span className="section-kicker">LOCAL RETENTION</span><h2 id="cleanup-title">清理本地运行历史</h2></div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="cleanup-controls">
          <label><span>保留最近</span><select value={days} disabled={busy} onChange={(event) => { setDays(Number(event.target.value)); onResetPreview(); }}><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option></select></label>
          <button className="button secondary" disabled={busy} onClick={() => void onPreview(days)}><Clock3 size={15} />生成预览</button>
        </div>
        <p className="cleanup-policy"><AlertTriangle size={15} />只清理已完成、已取消和已阻塞的运行；中断、待审批、待发布及可修复运行始终保留。确认删除后不可恢复。</p>
        <div className="cleanup-candidates">
          {preview ? (
            <>
              <div className="cleanup-summary"><strong>{preview.candidates.length} 个候选运行</strong><span>预计释放 {formatBytes(preview.totalBytes)}</span></div>
              {preview.candidates.map((candidate) => (
                <div className="cleanup-candidate" key={candidate.id}>
                  <RunStatusBadge status={candidate.status} />
                  <span><strong>{candidate.goal}</strong><small>{new Date(candidate.updatedAt).toLocaleString("zh-CN")} · {formatBytes(candidate.bytes)}</small></span>
                </div>
              ))}
              {preview.candidates.length === 0 && <div className="cleanup-empty"><ArchiveX size={24} /><span>这个保留范围内没有可清理运行</span></div>}
            </>
          ) : <div className="cleanup-empty"><Clock3 size={24} /><span>生成预览后才能确认清理</span></div>}
        </div>
        {error && <p className="form-error">{error}</p>}
        <footer>
          <button className="button secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="button danger-quiet" onClick={() => void onConfirm()} disabled={busy || !preview || preview.candidates.length === 0}><ArchiveX size={15} />确认删除 {preview?.candidates.length ?? 0} 个运行</button>
        </footer>
      </section>
    </div>
  );
}
