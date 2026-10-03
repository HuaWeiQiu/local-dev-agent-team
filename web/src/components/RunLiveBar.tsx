import { Loader2, ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { formatElapsed, type LiveStatus } from "../live-status";
import { cn } from "../ui/cn";

interface RunLiveBarProps {
  status: LiveStatus;
  onOpenActivity(): void;
}

/** One-line summary of what the selected run is doing right now; renders only for active runs. */
export function RunLiveBar({ status, onOpenActivity }: RunLiveBarProps) {
  const now = useNow(status.running);
  if (!status.running && status.pendingApprovals === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="bd flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-surface px-3.5 py-2 text-sm"
    >
      <span className="inline-flex items-center gap-1.5 font-semibold text-accent-ink">
        {status.running ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <ShieldQuestion className="size-3.5" aria-hidden="true" />
        )}
        {status.statusLabel}
      </span>
      {status.running && (
        <span className="flex flex-wrap items-center gap-1.5">
          {status.workers.length === 0 ? (
            <span className="text-xs text-muted">等待角色启动</span>
          ) : (
            <>
              {status.workers.map((worker) => (
                <span
                  key={worker.id}
                  className={cn(
                    "inline-flex h-5 items-center rounded-full bg-accent-soft px-2 text-2xs font-medium text-accent-ink",
                    worker.advisor && "bg-violet/15 text-violet",
                  )}
                >
                  {worker.label}
                </span>
              ))}
              {status.hiddenWorkers > 0 && <span className="text-xs text-muted">+{status.hiddenWorkers}</span>}
            </>
          )}
        </span>
      )}
      {status.pendingApprovals > 0 && (
        <span className="inline-flex h-5 items-center rounded-full bg-warning-soft px-2 text-2xs font-semibold text-warning-ink">
          {status.pendingApprovals} 项待审批
        </span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs tabular-nums text-muted">
        <span>任务 {status.tasksDone}/{status.tasksTotal}</span>
        <span>调用 {status.invocations.used}/{status.invocations.max}</span>
        {status.advisor && <span>顾问 {status.advisor.used}/{status.advisor.max}</span>}
        <span>已运行 {formatElapsed(status.startedAt, now)}</span>
      </span>
      <button
        type="button"
        onClick={onOpenActivity}
        className="cursor-pointer rounded border-0 bg-transparent px-1 text-xs font-medium text-accent-ink underline-offset-2 hover:underline focus-ring"
      >
        查看活动
      </button>
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
