import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDashed,
  Coins,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Package,
  RefreshCw,
  Timer,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import { formatBytes, formatTimestamp, shortRunId, strategyDisplayName } from "../presentation";
import type { UsageReport } from "../types";
import { Button } from "../ui/button";
import { Card, SectionTitle } from "../ui/card";
import { cn } from "../ui/cn";
import { EmptyState } from "./EmptyState";
import { RunStatusBadge } from "./StatusBadge";

interface UsagePanelProps {
  report: UsageReport | undefined;
  loading: boolean;
  selectedRunId: string | undefined;
  onRefresh(): void;
}

const headCell = "bd-b bg-surface-2 px-3 py-2 text-left text-2xs font-medium uppercase tracking-wider whitespace-nowrap text-muted first:pl-4 last:pr-4";
const bodyCell = "bd-b px-3 py-2.5 align-middle whitespace-nowrap text-ink-2 first:pl-4 last:pr-4";

export const UsagePanel = memo(function UsagePanel({ report, loading, selectedRunId, onRefresh }: UsagePanelProps) {
  if (!report) {
    return (
      <EmptyState
        {...(loading ? { role: "status" as const } : {})}
        icon={loading ? <CircleDashed className="motion-safe:animate-spin" /> : <Gauge />}
        title={loading ? "正在汇总用量数据" : "暂无用量数据"}
      />
    );
  }

  const totals = report.totals;
  return (
    <section aria-label="用量与成本" className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-6 [&>*]:shrink-0">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <SectionTitle>用量</SectionTitle>
          <h2 className="m-0 mt-0.5 text-lg font-semibold tracking-tight text-ink">用量与成本</h2>
        </div>
        <div className="flex items-center gap-2">
          <small className="text-xs text-muted">
            更新于 {formatTimestamp(report.generatedAt)} · {report.runCount} 个运行
          </small>
          <Button variant="secondary" size="icon-sm" onClick={onRefresh} disabled={loading} aria-label="刷新用量" title="刷新用量统计">
            <RefreshCw className={cn("size-3.5", loading && "motion-safe:animate-spin")} />
          </Button>
        </div>
      </header>

      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line p-0 sm:grid-cols-4">
        <UsageCard icon={<Coins />} label="估算成本" value={formatCost(totals.reportedCostUsd, totals.costReported)} emphasis />
        <UsageCard icon={<Cpu />} label="Agent 调用" value={totals.agentInvocations.toLocaleString()} />
        <UsageCard icon={<ArrowDownToLine />} label="输入 Token" value={totals.inputTokens.toLocaleString()} />
        <UsageCard icon={<Database />} label="缓存 Token" value={totals.cachedInputTokens.toLocaleString()} />
        <UsageCard icon={<ArrowUpFromLine />} label="输出 Token" value={totals.outputTokens.toLocaleString()} />
        <UsageCard icon={<Timer />} label="Agent 耗时" value={formatDuration(totals.agentDurationMs)} />
        <UsageCard icon={<HardDrive />} label="输出捕获" value={formatBytes(totals.processOutputBytes)} />
        <UsageCard icon={<Package />} label="运行产物" value={formatBytes(totals.artifactBytes)} />
      </Card>

      <Card className="min-w-0 overflow-hidden">
        <header className="bd-b px-4 py-3">
          <SectionTitle>按运行聚合</SectionTitle>
        </header>
        {report.runs.length === 0 ? (
          <EmptyState size="inline" title="尚无运行记录" hint="启动一个运行后，这里会按运行聚合用量。" />
        ) : (
          <div className="scroll-thin relative overflow-x-auto">
            <table aria-label="按运行聚合的用量" className="w-full min-w-[640px] border-collapse text-xs">
              <thead>
                <tr>
                  <th scope="col" className={headCell}>运行</th>
                  <th scope="col" className={headCell}>状态</th>
                  <th scope="col" className={cn(headCell, "text-right")}>Agent 调用</th>
                  <th scope="col" className={cn(headCell, "text-right")}>Token 入/出</th>
                  <th scope="col" className={cn(headCell, "text-right")}>估算成本</th>
                  <th scope="col" className={cn(headCell, "text-right")}>产物</th>
                  <th scope="col" className={cn(headCell, "text-right")}>更新于</th>
                </tr>
              </thead>
              <tbody>
                {report.runs.map((entry) => (
                  <tr
                    key={entry.runId}
                    aria-current={entry.runId === selectedRunId ? "true" : undefined}
                    className={cn("transition-colors", entry.runId === selectedRunId ? "bg-accent-soft" : "hover:bg-surface-2")}
                  >
                    <td className={cn(bodyCell, "max-w-[18rem]")}>
                      <strong className="block truncate text-sm font-medium text-ink" title={entry.goal}>{entry.goal}</strong>
                      <small className="mt-0.5 block text-2xs text-muted" title={entry.strategy}>{shortRunId(entry.runId)} · {strategyDisplayName(entry.strategy)}</small>
                    </td>
                    <td className={bodyCell}><RunStatusBadge status={entry.status} /></td>
                    <td className={cn(bodyCell, "text-right tabular-nums")}>{entry.usage.agentInvocations.toLocaleString()}</td>
                    <td className={cn(bodyCell, "text-right tabular-nums")}>
                      {entry.usage.inputTokens.toLocaleString()} / {entry.usage.outputTokens.toLocaleString()}
                    </td>
                    <td className={cn(bodyCell, "text-right tabular-nums")}>{formatCost(entry.usage.reportedCostUsd, entry.usage.costReported)}</td>
                    <td className={cn(bodyCell, "text-right tabular-nums")}>{formatBytes(entry.usage.artifactBytes)}</td>
                    <td className={cn(bodyCell, "text-right text-muted")}>{formatTimestamp(entry.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
});

function UsageCard({ icon, label, value, emphasis }: { icon: ReactNode; label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={cn("usage-card flex min-w-0 flex-col gap-1 px-4 py-3 [&_svg]:size-3.5 [&_svg]:shrink-0", emphasis ? "is-emphasis bg-accent-soft" : "bg-surface")}>
      <small className={cn("flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider [&_svg]:opacity-80", emphasis ? "text-accent-ink" : "text-muted")}>
        <span aria-hidden className="inline-flex">{icon}</span>
        {label}
      </small>
      <strong className={cn("break-words text-lg font-semibold tabular-nums tracking-tight", emphasis ? "text-accent-ink" : "text-ink")}>{value}</strong>
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
