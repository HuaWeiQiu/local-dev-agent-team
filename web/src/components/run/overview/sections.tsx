import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Coins,
  Cpu,
  ListChecks,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { humanizeFailure } from "../../../presentation";
import { formatRelative } from "../../../time";
import type { ExplainLine, RunState, TaskRunState } from "../../../types";
import type { TimelineEntry } from "../../../timeline";
import { Badge } from "../../../ui/badge";
import { Card, SectionTitle } from "../../../ui/card";
import { cn } from "../../../ui/cn";
import { StatusDot, TaskStatusPill, normalizeTone } from "../../../ui/status";
import { completedTasks, decisionLabel, headlineToneClass, summaryStats, type SummaryStat } from "./model";

export function verdictIcon(verdict: string | undefined, passed?: boolean): ReactNode {
  if (verdict === "approve" || passed === true) {
    return <CheckCircle2 className="size-4 text-success" aria-label="通过" />;
  }
  if (verdict === "request_changes" || passed === false) {
    return <XCircle className="size-4 text-danger" aria-label="未通过" />;
  }
  if (verdict === "escalate") return <AlertTriangle className="size-4 text-warning" aria-label="需升级" />;
  return <CircleDashed className="size-4 text-muted/70" aria-label="未开始" />;
}

export function FailureBanner({ error }: { error: string | undefined }) {
  const failure = humanizeFailure(error);
  if (!failure) return null;
  return (
    <div className="flex gap-3 rounded-lg border border-solid border-danger/35 bg-danger-soft px-4 py-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div>
        <strong className="block text-sm font-semibold text-danger-ink">运行没有完成</strong>
        <p className="m-0 mt-0.5 text-sm leading-snug text-ink-2">{failure}</p>
      </div>
    </div>
  );
}

export function HeadlineCard({ headline }: { headline: ExplainLine }) {
  return (
    <Card className="p-4">
      <SectionTitle>结论</SectionTitle>
      <p className={cn("m-0 mt-1.5 text-sm font-medium leading-snug", headlineToneClass(headline.tone))}>
        {headline.text}
      </p>
    </Card>
  );
}

export function PlanCard({
  run,
  onOpenArchitecture,
}: {
  run: RunState;
  onOpenArchitecture: (() => void) | undefined;
}) {
  const summary = run.plan?.summary;
  const decision = run.finalDecision;
  if (!summary && !decision) return null;
  return (
    <Card className="p-4">
      {summary && (
        <>
          <div className="flex items-center">
            <SectionTitle>计划</SectionTitle>
            <button
              type="button"
              onClick={onOpenArchitecture}
              className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-accent-ink hover:underline focus-ring"
            >
              打开架构图
            </button>
          </div>
          <p className="m-0 mt-1.5 text-sm leading-relaxed text-ink-2">{summary}</p>
        </>
      )}
      {decision && <DecisionRow decision={decision} spaced={Boolean(summary)} />}
    </Card>
  );
}

function DecisionRow({
  decision,
  spaced,
}: {
  decision: NonNullable<RunState["finalDecision"]>;
  spaced: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-2", spaced && "bd-t mt-3 pt-3")}>
      <Badge tone={decision.decision === "ready" ? "success" : "warning"}>
        {decisionLabel(decision.decision)}
      </Badge>
      <span className="text-sm text-ink-2">{decision.reason}</span>
    </div>
  );
}

export function TaskTable({
  run,
  onSelectTask,
}: {
  run: RunState;
  onSelectTask(task: TaskRunState): void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="bd-b flex items-center gap-2 px-4 py-3">
        <ListChecks className="size-4 text-muted" />
        <SectionTitle>任务</SectionTitle>
        <span className="text-xs text-muted">
          {completedTasks(run)}/{run.tasks.length} 完成
        </span>
      </div>
      {run.tasks.length === 0 ? (
        <p className="m-0 px-4 py-8 text-center text-sm text-muted">还没有拆分出任务</p>
      ) : (
        <TaskTableBody tasks={run.tasks} onSelectTask={onSelectTask} />
      )}
    </Card>
  );
}

function TaskTableBody({
  tasks,
  onSelectTask,
}: {
  tasks: RunState["tasks"];
  onSelectTask(task: TaskRunState): void;
}) {
  return (
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
        {tasks.map((task) => (
          <TaskRow key={task.task.id} task={task} onSelectTask={onSelectTask} />
        ))}
      </tbody>
    </table>
  );
}

function TaskRow({ task, onSelectTask }: { task: TaskRunState; onSelectTask(task: TaskRunState): void }) {
  return (
    <tr
      tabIndex={0}
      onClick={() => onSelectTask(task)}
      onKeyDown={(event) => onRowKey(event, task, onSelectTask)}
      className="cursor-pointer transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
    >
      <TaskTitleCell task={task} />
      <td className="bd-b px-2 py-2.5">
        <TaskStatusPill status={task.status} />
      </td>
      <td className="bd-b hidden px-2 py-2.5 text-center sm:table-cell">
        {verdictIcon(undefined, task.quality?.passed)}
      </td>
      <td className="bd-b hidden px-2 py-2.5 text-center sm:table-cell">
        {verdictIcon(task.review?.verdict)}
      </td>
      <td className="bd-b hidden px-2 py-2.5 text-center sm:table-cell">
        {verdictIcon(task.test?.verdict)}
      </td>
      <td className="bd-b px-4 py-2.5 text-right tabular-nums text-muted">{task.attempts}</td>
    </tr>
  );
}

/** Enter selects a task, exactly like a click on the row. */
function onRowKey(
  event: { key: string },
  task: TaskRunState,
  onSelectTask: (task: TaskRunState) => void,
): void {
  if (event.key !== "Enter") return;
  onSelectTask(task);
}

function TaskTitleCell({ task }: { task: TaskRunState }) {
  return (
    <td className="bd-b max-w-0 px-4 py-2.5">
      <span className="block truncate font-medium text-ink">{task.task.title}</span>
      {task.task.ownedPaths[0] && (
        <code className="block truncate text-2xs text-muted">{task.task.ownedPaths[0]}</code>
      )}
    </td>
  );
}

export function SummaryAside({
  run,
  timeline,
  onOpenActivity,
}: {
  run: RunState;
  timeline: TimelineEntry[];
  onOpenActivity(): void;
}) {
  return (
    <aside className="flex min-w-0 flex-col gap-4" aria-label="运行摘要">
      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line p-0">
        {summaryStats(run).map((stat) => (
          <Stat key={stat.label} stat={stat} />
        ))}
      </Card>
      <Card className="p-4">
        <div className="flex items-center">
          <SectionTitle>最近动态</SectionTitle>
          <button
            type="button"
            onClick={onOpenActivity}
            className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-accent-ink hover:underline focus-ring"
          >
            全部
          </button>
        </div>
        {timeline.length === 0 ? (
          <p className="m-0 mt-3 text-sm text-muted">暂无事件</p>
        ) : (
          <TimelineList timeline={timeline} />
        )}
      </Card>
    </aside>
  );
}

function TimelineList({ timeline }: { timeline: TimelineEntry[] }) {
  return (
    <ol className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
      {timeline.map((entry) => (
        <li key={entry.key} className="flex gap-2.5">
          <StatusDot tone={normalizeTone(entry.tone)} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium text-ink">{entry.title}</span>
              <time
                className="ml-auto w-16 shrink-0 text-right text-2xs tabular-nums text-muted"
                dateTime={entry.at}
              >
                {formatRelative(entry.at)}
              </time>
            </div>
            {entry.detail && <p className="m-0 line-clamp-2 text-xs leading-snug text-muted">{entry.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const STAT_ICONS = {
  clock: Clock,
  cpu: Cpu,
  coins: Coins,
  list: ListChecks,
} as const;

function Stat({ stat }: { stat: SummaryStat }) {
  const Icon = STAT_ICONS[stat.icon];
  return (
    <div className="flex flex-col gap-1 bg-surface px-4 py-3 [&_svg]:size-3.5 [&_svg]:text-muted">
      <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-muted">
        <Icon />
        {stat.label}
      </span>
      <strong className="text-lg font-semibold tabular-nums tracking-tight text-ink">{stat.value}</strong>
    </div>
  );
}
