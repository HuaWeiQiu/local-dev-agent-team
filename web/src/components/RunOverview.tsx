import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Coins, Cpu, ListChecks, XCircle } from "lucide-react";
import { useMemo } from "react";
import { formatElapsed } from "../live-status";
import { humanizeFailure } from "../presentation";
import { deriveTimeline } from "../timeline";
import type { ExplainLine, RunEvent, RunState, TaskRunState } from "../types";
import { Badge } from "../ui/badge";
import { Card, SectionTitle } from "../ui/card";
import { cn } from "../ui/cn";
import { StatusDot, TaskStatusPill, normalizeTone } from "../ui/status";
import { formatRelative } from "../time";

interface RunOverviewProps {
  run: RunState | undefined;
  events: RunEvent[];
  /** One-line, evidence-backed answer to "why is the run in this state". */
  headline?: ExplainLine | undefined;
  onSelectTask(task: TaskRunState): void;
  onOpenActivity(): void;
  onOpenArchitecture?(): void;
}

function verdictIcon(verdict: string | undefined, passed?: boolean) {
  if (verdict === "approve" || passed === true) return <CheckCircle2 className="size-4 text-success" aria-label="通过" />;
  if (verdict === "request_changes" || passed === false) return <XCircle className="size-4 text-danger" aria-label="未通过" />;
  if (verdict === "escalate") return <AlertTriangle className="size-4 text-warning" aria-label="需升级" />;
  return <CircleDashed className="size-4 text-muted/70" aria-label="未开始" />;
}

export function RunOverview({ run, events, headline, onSelectTask, onOpenActivity, onOpenArchitecture }: RunOverviewProps) {
  const timeline = useMemo(() => deriveTimeline(run, events).slice(-8).reverse(), [run, events]);
  if (!run) return <div className="grid h-full place-items-center text-sm text-muted">选择一个运行查看概览</div>;

  const failure = humanizeFailure(run.error);
  const done = run.tasks.filter((task) => task.status === "passed" || task.status === "merged").length;
  const terminal = ["completed", "cancelled", "blocked", "interrupted", "ci-failed", "ready-to-merge"].includes(run.status);
  const elapsed = formatElapsed(run.createdAt, terminal ? Date.parse(run.updatedAt) : Date.now());
  const usage = run.usage;

  return (
    <div className="scroll-thin grid h-full content-start gap-4 overflow-y-auto p-4 md:p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        {failure && (
          <div className="flex gap-3 rounded-lg border border-solid border-danger/35 bg-danger-soft px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div>
              <strong className="block text-sm font-semibold text-danger-ink">运行没有完成</strong>
              <p className="m-0 mt-0.5 text-sm leading-snug text-ink-2">{failure}</p>
            </div>
          </div>
        )}
        {headline && (
          <Card className="p-4">
            <SectionTitle>结论</SectionTitle>
            <p
              className={cn(
                "m-0 mt-1.5 text-sm font-medium leading-snug",
                headline.tone === "good" ? "text-success-ink" : headline.tone === "bad" ? "text-danger-ink" : headline.tone === "warn" ? "text-warning-ink" : "text-ink-2",
              )}
            >
              {headline.text}
            </p>
          </Card>
        )}
        {(run.plan?.summary || run.finalDecision) && (
          <Card className="p-4">
            {run.plan?.summary && (
              <>
                <div className="flex items-center">
                  <SectionTitle>计划</SectionTitle>
                  <button
                    type="button"
                    onClick={() => onOpenArchitecture?.()}
                    className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-accent-ink hover:underline focus-ring"
                  >
                    打开架构图
                  </button>
                </div>
                <p className="m-0 mt-1.5 text-sm leading-relaxed text-ink-2">{run.plan.summary}</p>
              </>
            )}
            {run.finalDecision && (
              <div className={cn("flex items-start gap-2", run.plan?.summary && "bd-t mt-3 pt-3")}>
                <Badge tone={run.finalDecision.decision === "ready" ? "success" : "warning"}>
                  {run.finalDecision.decision === "ready" ? "总控：可交付" : "总控：需升级"}
                </Badge>
                <span className="text-sm text-ink-2">{run.finalDecision.reason}</span>
              </div>
            )}
          </Card>
        )}
        <Card className="overflow-hidden">
          <div className="bd-b flex items-center gap-2 px-4 py-3">
            <ListChecks className="size-4 text-muted" />
            <SectionTitle>任务</SectionTitle>
            <span className="text-xs text-muted">{done}/{run.tasks.length} 完成</span>
          </div>
          {run.tasks.length === 0 ? (
            <p className="m-0 px-4 py-8 text-center text-sm text-muted">还没有拆分出任务</p>
          ) : (
            <table className="w-full border-collapse text-sm" aria-label="任务概览">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-muted">
                  <th className="bd-b px-4 py-2 font-medium">任务</th>
                  <th className="bd-b px-2 py-2 font-medium">状态</th>
                  <th className="bd-b hidden px-2 py-2 text-center font-medium sm:table-cell">检查</th>
                  <th className="bd-b hidden px-2 py-2 text-center font-medium sm:table-cell">评审</th>
                  <th className="bd-b hidden px-2 py-2 text-center font-medium sm:table-cell">测试</th>
                  <th className="bd-b px-4 py-2 text-right font-medium">尝试</th>
                </tr>
              </thead>
              <tbody>
                {run.tasks.map((task) => (
                  <tr
                    key={task.task.id}
                    tabIndex={0}
                    onClick={() => onSelectTask(task)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onSelectTask(task);
                    }}
                    className="cursor-pointer transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  >
                    <td className="bd-b max-w-0 px-4 py-2.5">
                      <span className="block truncate font-medium text-ink">{task.task.title}</span>
                      {task.task.ownedPaths[0] && <code className="block truncate text-2xs text-muted">{task.task.ownedPaths[0]}</code>}
                    </td>
                    <td className="bd-b px-2 py-2.5"><TaskStatusPill status={task.status} /></td>
                    <td className="bd-b hidden px-2 py-2.5 text-center sm:table-cell">{verdictIcon(undefined, task.quality?.passed)}</td>
                    <td className="bd-b hidden px-2 py-2.5 text-center sm:table-cell">{verdictIcon(task.review?.verdict)}</td>
                    <td className="bd-b hidden px-2 py-2.5 text-center sm:table-cell">{verdictIcon(task.test?.verdict)}</td>
                    <td className="bd-b px-4 py-2.5 text-right tabular-nums text-muted">{task.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <aside className="flex min-w-0 flex-col gap-4" aria-label="运行摘要">
        <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line p-0">
          <Stat icon={<Clock />} label="耗时" value={elapsed} />
          <Stat icon={<Cpu />} label="调用" value={`${usage?.agentInvocations ?? 0}/${run.strategy.maxAgentInvocations}`} />
          <Stat icon={<Coins />} label="成本" value={usage?.reportedCostUsd != null ? `$${usage.reportedCostUsd.toFixed(2)}` : "—"} />
          <Stat icon={<ListChecks />} label="返工" value={String(run.tasks.reduce((sum, task) => sum + Math.max(0, task.attempts - 1), 0))} />
        </Card>
        <Card className="p-4">
          <div className="flex items-center">
            <SectionTitle>最近动态</SectionTitle>
            <button type="button" onClick={onOpenActivity} className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-accent-ink hover:underline focus-ring">全部</button>
          </div>
          {timeline.length === 0 ? (
            <p className="m-0 mt-3 text-sm text-muted">暂无事件</p>
          ) : (
            <ol className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
              {timeline.map((entry) => (
                <li key={entry.key} className="flex gap-2.5">
                  <StatusDot tone={normalizeTone(entry.tone)} className="mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium text-ink">{entry.title}</span>
                      <time className="ml-auto w-16 shrink-0 text-right text-2xs tabular-nums text-muted" dateTime={entry.at}>{formatRelative(entry.at)}</time>
                    </div>
                    {entry.detail && <p className="m-0 line-clamp-2 text-xs leading-snug text-muted">{entry.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </aside>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 bg-surface px-4 py-3 [&_svg]:size-3.5 [&_svg]:text-muted">
      <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-muted">{icon}{label}</span>
      <strong className="text-lg font-semibold tabular-nums tracking-tight text-ink">{value}</strong>
    </div>
  );
}
