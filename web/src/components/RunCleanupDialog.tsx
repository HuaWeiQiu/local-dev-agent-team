import { ArchiveX, Clock3 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { formatBytes } from "../presentation";
import type { RunCleanupPreview } from "../types";
import { Button } from "../ui/button";
import { Modal } from "../ui/dialog";
import { Callout, Select } from "../ui/form";
import { RunStatusPill } from "../ui/status";

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

  const count = preview?.candidates.length ?? 0;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
      locked={busy}
      title="清理本地运行历史"
      description="按保留期预览并删除早期运行的本地记录。"
      className="w-[min(640px,calc(100vw-32px))]"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="danger" onClick={() => void onConfirm()} disabled={busy || !preview || count === 0}>
            <ArchiveX />确认删除 {count} 个运行
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-ink-2">
            <span>保留最近</span>
            <Select
              className="w-44"
              value={days}
              disabled={busy}
              onChange={(event) => {
                setDays(Number(event.target.value));
                onResetPreview();
              }}
            >
              <option value={0}>不保留（全部可删）</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
              <option value={180}>180 天</option>
            </Select>
          </label>
          <Button variant="secondary" disabled={busy} onClick={() => void onPreview(days)}>
            <Clock3 />生成预览
          </Button>
        </div>

        <Callout tone="warning">
          可清理：已完成 / 已取消 / 已阻塞 / 已中断。执行中、待审批、仍被其他运行引用为父运行的会保留。确认后不可恢复。
        </Callout>

        <div className="bd overflow-hidden rounded-lg">
          {preview ? (
            <>
              <div className="bd-b flex items-center justify-between bg-surface-2 px-3 py-2 text-xs">
                <strong className="text-ink">{count} 个候选运行</strong>
                <span className="text-muted">预计释放 {formatBytes(preview.totalBytes)}</span>
              </div>
              {count === 0 ? (
                <Empty icon={<ArchiveX className="size-5" />} title="这个保留范围内没有可清理运行" />
              ) : (
                <ul className="scroll-thin m-0 max-h-64 list-none divide-y divide-line overflow-y-auto p-0">
                  {preview.candidates.map((candidate) => (
                    <li key={candidate.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 px-3 py-2.5">
                      <span className="justify-self-start"><RunStatusPill status={candidate.status} /></span>
                      <strong className="min-w-0 truncate text-sm font-medium text-ink" title={candidate.goal}>{candidate.goal}</strong>
                      <small className="col-start-2 text-xs tabular-nums text-muted">
                        {new Date(candidate.updatedAt).toLocaleString("zh-CN")} · {formatBytes(candidate.bytes)}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <Empty icon={<Clock3 className="size-5" />} title="生成预览后才能确认清理" />
          )}
        </div>

        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </div>
    </Modal>
  );
}

function Empty({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted">
      <span aria-hidden className="grid size-9 place-items-center rounded-full bg-surface-3">{icon}</span>
      <strong className="font-medium text-ink-2">{title}</strong>
    </div>
  );
}
