import { CircleDashed, Gauge, RefreshCw } from "lucide-react";
import { memo } from "react";
import { formatBytes, formatTimestamp, shortRunId } from "../presentation";
import type { UsageReport } from "../types";
import { RunStatusBadge } from "./StatusBadge";

interface UsagePanelProps {
  report: UsageReport | undefined;
  loading: boolean;
  selectedRunId: string | undefined;
  onRefresh(): void;
}

export const UsagePanel = memo(function UsagePanel({ report, loading, selectedRunId, onRefresh }: UsagePanelProps) {
  if (!report) {
    return (
      <div className="usage-empty">
        {loading ? <CircleDashed className="spin" size={28} /> : <Gauge size={28} />}
        <strong>{loading ? "正在汇总用量数据" : "暂无用量数据"}</strong>
      </div>
    );
  }

  const totals = report.totals;
  return (
    <section className="usage-panel" aria-label="用量与成本">
      <header className="usage-panel-header">
        <div>
          <span className="section-kicker">USAGE</span>
          <h2>用量与成本</h2>
        </div>
        <div className="usage-panel-tools">
          <small className="usage-generated">
            更新于 {formatTimestamp(report.generatedAt)} · {report.runCount} 个运行
          </small>
          <button
            className="icon-button compact"
            onClick={onRefresh}
            disabled={loading}
            aria-label="刷新用量"
            title="刷新用量统计"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      <div className="usage-grid">
        <UsageCard label="估算成本" value={formatCost(totals.reportedCostUsd, totals.costReported)} emphasis />
        <UsageCard label="Agent 调用" value={totals.agentInvocations.toLocaleString()} />
        <UsageCard label="输入 Token" value={totals.inputTokens.toLocaleString()} />
        <UsageCard label="缓存 Token" value={totals.cachedInputTokens.toLocaleString()} />
        <UsageCard label="输出 Token" value={totals.outputTokens.toLocaleString()} />
        <UsageCard label="Agent 耗时" value={formatDuration(totals.agentDurationMs)} />
        <UsageCard label="输出捕获" value={formatBytes(totals.processOutputBytes)} />
        <UsageCard label="运行产物" value={formatBytes(totals.artifactBytes)} />
      </div>

      {report.runs.length === 0 ? (
        <p className="usage-notice">尚无运行记录，启动一个运行后这里会按运行聚合用量。</p>
      ) : (
        <div className="usage-table-wrap">
          <table className="usage-table" aria-label="按运行聚合的用量">
            <thead>
              <tr>
                <th>运行</th>
                <th>状态</th>
                <th>Agent 调用</th>
                <th>Token 入/出</th>
                <th>估算成本</th>
                <th>产物</th>
                <th>更新于</th>
              </tr>
            </thead>
            <tbody>
              {report.runs.map((entry) => (
                <tr key={entry.runId} className={entry.runId === selectedRunId ? "is-selected" : ""}>
                  <td className="usage-run-cell">
                    <strong>{entry.goal}</strong>
                    <small>{shortRunId(entry.runId)} · {entry.strategy}</small>
                  </td>
                  <td><RunStatusBadge status={entry.status} /></td>
                  <td className="num">{entry.usage.agentInvocations.toLocaleString()}</td>
                  <td className="num">
                    {entry.usage.inputTokens.toLocaleString()} / {entry.usage.outputTokens.toLocaleString()}
                  </td>
                  <td className="num">{formatCost(entry.usage.reportedCostUsd, entry.usage.costReported)}</td>
                  <td className="num">{formatBytes(entry.usage.artifactBytes)}</td>
                  <td>{formatTimestamp(entry.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
});

function UsageCard({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`usage-card${emphasis ? " is-emphasis" : ""}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function formatCost(costUsd: number, reported: boolean): string {
  return reported ? `$${costUsd.toFixed(4)}` : "—";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}
