import { Loader2, ShieldQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { formatElapsed, type LiveStatus } from "../live-status";

interface RunLiveBarProps {
  status: LiveStatus;
  onOpenActivity(): void;
}

/** One-line summary of what the selected run is doing right now; renders only for active runs. */
export function RunLiveBar({ status, onOpenActivity }: RunLiveBarProps) {
  const now = useNow(status.running);
  if (!status.running && status.pendingApprovals === 0) return null;
  return (
    <div className="run-live-bar" role="status" aria-live="polite">
      <span className="run-live-stage">
        {status.running ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <ShieldQuestion size={14} aria-hidden="true" />}
        {status.statusLabel}
      </span>
      {status.running && (
        <span className="run-live-workers">
          {status.workers.length === 0 ? (
            <span className="run-live-muted">等待角色启动</span>
          ) : (
            <>
              {status.workers.map((worker) => (
                <span key={worker.id} className={`run-live-worker${worker.advisor ? " is-advisor" : ""}`}>{worker.label}</span>
              ))}
              {status.hiddenWorkers > 0 && <span className="run-live-muted">+{status.hiddenWorkers}</span>}
            </>
          )}
        </span>
      )}
      {status.pendingApprovals > 0 && <span className="run-live-pill is-attention">{status.pendingApprovals} 项待审批</span>}
      <span className="run-live-meta">
        <span>任务 {status.tasksDone}/{status.tasksTotal}</span>
        <span>调用 {status.invocations.used}/{status.invocations.max}</span>
        {status.advisor && <span>顾问 {status.advisor.used}/{status.advisor.max}</span>}
        <span>已运行 {formatElapsed(status.startedAt, now)}</span>
      </span>
      <button type="button" className="run-live-link" onClick={onOpenActivity}>查看活动</button>
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
