import { Filter, Plus, Search, Trash2, Workflow } from "lucide-react";
import { memo, useMemo, useState } from "react";
import {
  activeRunStatuses,
  formatTimestamp,
  runListSubtitle,
  shortRunId,
  strategyDisplayName,
  summarizeGoal,
} from "../presentation";
import type { RunStatus, RunSummary } from "../types";
import { RunStatusBadge } from "./StatusBadge";

interface RunRailProps {
  runs: RunSummary[];
  selectedRunId: string | undefined;
  busy?: boolean;
  onSelect(runId: string): void;
  onCreate(): void;
  onCleanup(): void;
  onDelete?(runId: string): void;
}

type RunFilter = "all" | "active" | "attention" | "finished";

export const RunRail = memo(function RunRail({
  runs,
  selectedRunId,
  busy = false,
  onSelect,
  onCreate,
  onCleanup,
  onDelete,
}: RunRailProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RunFilter>("all");
  const visibleRuns = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return runs.filter((run) => {
      const matchesQuery = !normalized || [
        run.goal,
        run.strategy,
        strategyDisplayName(run.strategy),
        run.id,
        run.error ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(normalized));
      const matchesFilter = filter === "all" || (filter === "active" && activeRunStatuses.has(run.status)) || (filter === "attention" && attentionStatuses.has(run.status)) || (filter === "finished" && finishedStatuses.has(run.status));
      return matchesQuery && matchesFilter;
    });
  }, [filter, query, runs]);

  return (
    <aside className="run-rail" aria-label="运行列表">
      <div className="section-heading rail-heading">
        <div className="rail-title">
          <div><h2>运行记录</h2><span className="rail-count">{visibleRuns.length === runs.length ? runs.length : `${visibleRuns.length}/${runs.length}`}</span></div>
        </div>
        <div className="rail-actions"><button className="icon-button" onClick={onCleanup} title="批量清理历史" aria-label="批量清理历史"><Trash2 size={16} /></button><button className="icon-button primary-icon" onClick={onCreate} title="新建运行" aria-label="新建运行"><Plus size={18} /></button></div>
      </div>
      <label className="run-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索目标、失败原因或 ID" aria-label="搜索运行" />
      </label>
      <label className="run-filter"><Filter size={14} /><select value={filter} onChange={(event) => setFilter(event.target.value as RunFilter)} aria-label="运行状态筛选"><option value="all">全部状态</option><option value="active">执行中</option><option value="attention">需要处理（含待 CLI 合并）</option><option value="finished">已完成</option></select></label>
      <div className="run-list">
        {visibleRuns.map((run) => {
          const completed = run.taskCounts.merged + run.taskCounts.passed;
          const total = Object.values(run.taskCounts).reduce((sum, count) => sum + count, 0);
          const referencedAsParent = runs.some((item) => item.parentRunId === run.id);
          const canDelete = deletableStatuses.has(run.status) && !referencedAsParent;
          return (
            <div
              key={run.id}
              className={`run-item ${selectedRunId === run.id ? "is-selected" : ""}`}
            >
              <button type="button" className="run-item-main" onClick={() => onSelect(run.id)}>
                <span className="run-item-topline">
                  <RunStatusBadge status={run.status} />
                  <time>{formatTimestamp(run.updatedAt)}</time>
                </span>
                <strong title={run.goal}>{summarizeGoal(run.goal)}</strong>
                <span className={`run-item-reason ${run.error ? "is-error" : ""}`}>
                  {runListSubtitle(run)}
                </span>
                <span className="run-item-meta">
                  <code title={run.id}>{shortRunId(run.id)}</code>
                  <span title={run.strategy}>{strategyDisplayName(run.strategy)}</span>
                </span>
                <span className="run-progress">
                  <span>{total === 0 ? "尚无任务" : `${completed} / ${total} 个任务`}</span>
                  <span
                    className="progress-track"
                    role="progressbar"
                    aria-label="任务进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={total === 0 ? 0 : Math.round((completed / total) * 100)}
                    aria-valuetext={total === 0 ? "尚无任务" : `${completed}/${total} 个任务`}
                  >
                    <span style={{ width: total === 0 ? "0%" : `${(completed / total) * 100}%` }} />
                  </span>
                </span>
              </button>
              {deletableStatuses.has(run.status) && onDelete ? (
                <button
                  type="button"
                  className="run-item-delete"
                  title={referencedAsParent ? "仍被后续运行引用，结束后才能删除" : "删除此运行"}
                  aria-label={referencedAsParent ? `运行 ${shortRunId(run.id)} 仍被后续运行引用` : `删除运行 ${shortRunId(run.id)}`}
                  disabled={busy || referencedAsParent}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (referencedAsParent) return;
                    onDelete(run.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          );
        })}
        {visibleRuns.length === 0 && (
          <div className="empty-rail">
            <Workflow size={22} />
            <span>{runs.length === 0 ? "暂无运行" : "没有匹配的运行"}</span>
          </div>
        )}
      </div>
    </aside>
  );
});

const attentionStatuses = new Set(["awaiting-human", "ci-failed", "ready-to-merge", "cancelled", "interrupted", "blocked"]);
const finishedStatuses = new Set(["completed"]);
const deletableStatuses = new Set<RunStatus>(["completed", "cancelled", "blocked", "interrupted"]);
