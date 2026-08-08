import { Plus, Workflow } from "lucide-react";
import { formatTimestamp, shortRunId } from "../presentation";
import type { RunSummary } from "../types";
import { RunStatusBadge } from "./StatusBadge";

interface RunRailProps {
  runs: RunSummary[];
  selectedRunId: string | undefined;
  onSelect(runId: string): void;
  onCreate(): void;
}

export function RunRail({ runs, selectedRunId, onSelect, onCreate }: RunRailProps) {
  return (
    <aside className="run-rail" aria-label="运行列表">
      <div className="section-heading rail-heading">
        <div className="rail-title">
          <span className="section-kicker">RUNS</span>
          <div><h2>运行记录</h2><span className="rail-count">{runs.length}</span></div>
        </div>
        <button className="icon-button primary-icon" onClick={onCreate} title="新建运行" aria-label="新建运行">
          <Plus size={18} />
        </button>
      </div>
      <div className="run-list">
        {runs.map((run) => {
          const completed = run.taskCounts.merged + run.taskCounts.passed;
          const total = Object.values(run.taskCounts).reduce((sum, count) => sum + count, 0);
          return (
            <button
              key={run.id}
              className={`run-item ${selectedRunId === run.id ? "is-selected" : ""}`}
              onClick={() => onSelect(run.id)}
            >
              <span className="run-item-topline">
                <RunStatusBadge status={run.status} />
                <time>{formatTimestamp(run.updatedAt)}</time>
              </span>
              <strong>{run.goal}</strong>
              <span className="run-item-meta">
                <code title={run.id}>{shortRunId(run.id)}</code>
                <span>{run.strategy}</span>
              </span>
              <span className="run-progress">
                <span>{total === 0 ? "等待任务拆分" : `${completed} / ${total} 个任务`}</span>
                <span
                  className="progress-track"
                  role="progressbar"
                  aria-label="任务进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={total === 0 ? 0 : Math.round((completed / total) * 100)}
                  aria-valuetext={total === 0 ? "等待任务拆分" : `${completed}/${total} 个任务`}
                >
                  <span style={{ width: total === 0 ? "0%" : `${(completed / total) * 100}%` }} />
                </span>
              </span>
            </button>
          );
        })}
        {runs.length === 0 && (
          <div className="empty-rail">
            <Workflow size={22} />
            <span>暂无运行</span>
          </div>
        )}
      </div>
    </aside>
  );
}
