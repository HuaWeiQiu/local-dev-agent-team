import { BookMarked, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { ExperienceSnapshot } from "../../../types";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { Callout } from "../../../ui/form";
import { Tooltip } from "../../../ui/tooltip";
import { statsOf } from "./model";

export function WorkbenchHeader({
  snapshot,
  loading,
  busy,
  onRefresh,
}: {
  snapshot: ExperienceSnapshot;
  loading: boolean;
  busy: boolean;
  onRefresh(): void;
}) {
  return (
    <header className="bd-b flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface px-4 py-2.5">
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <BookMarked className="size-4" />
        </span>
        <div className="min-w-0">
          <strong className="block text-sm font-semibold text-ink">经验</strong>
          <span className="block truncate text-xs text-muted">
            候选需晋升 · 已验证进规划 · 共享后跨项目
            {snapshot.enabled ? "" : " · 已关闭"}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2" aria-label="经验统计" role="group">
        {statsOf(snapshot).map((stat) => (
          <Metric key={stat.label} label={stat.label} value={stat.value} tone={stat.tone} />
        ))}
        <Tooltip label="刷新">
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={loading || busy}
            aria-label="刷新"
          >
            <RefreshCw className={cn(loading && "animate-spin")} />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="bd inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-2xs text-muted">
      {label}
      <strong className={cn("text-xs font-semibold tabular-nums", tone)}>{value}</strong>
    </span>
  );
}

export function WorkbenchLoading() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div role="status" className="flex flex-col items-center gap-3 text-sm text-muted">
        <LoaderCircle aria-hidden className="size-6 animate-spin text-accent" />
        <span>加载中…</span>
      </div>
    </div>
  );
}

export function WorkbenchFailure({
  error,
  onRetry,
}: {
  error: string | undefined;
  onRetry(): void;
}) {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <strong className="text-base font-semibold text-ink">加载失败</strong>
        <Callout tone="danger" role="alert" className="w-full text-left">{error}</Callout>
        <Button onClick={onRetry}>
          <RefreshCw />
          重试
        </Button>
      </div>
    </div>
  );
}

export function InspectorAside({ wide, children }: { wide: boolean; children: ReactNode }) {
  if (wide) {
    return (
      <aside className="scroll-thin bd-l min-h-0 min-w-0 overflow-y-auto bg-surface p-4">
        {children}
      </aside>
    );
  }
  return <div className="bd-t pt-5">{children}</div>;
}
