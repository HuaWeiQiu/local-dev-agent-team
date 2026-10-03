import { Compass, CornerDownRight } from "lucide-react";
import {
  agentRoleLabel,
  agentStatusLabel,
  type AdvisorLogEntry,
  type AgentDisplayStatus,
  type AgentInvocationActivity,
} from "../../agent-activity";
import { advisorRecommendationLabel, advisorTriggerLabel, formatTimestamp, jevEntryText } from "../../presentation";
import { Badge } from "../../ui/badge";
import { Card } from "../../ui/card";
import { cn } from "../../ui/cn";
import { StatusDot, type StatusToneName } from "../../ui/status";
import { EmptyState } from "../EmptyState";

const statusTone: Record<AgentDisplayStatus, StatusToneName> = {
  pending: "active",
  running: "active",
  completed: "success",
  failed: "danger",
  interrupted: "warning",
  shutdown: "warning",
  unknown: "neutral",
};

const statusText: Record<AgentDisplayStatus, string> = {
  pending: "text-accent-ink",
  running: "text-accent-ink",
  completed: "text-success-ink",
  failed: "text-danger-ink",
  interrupted: "text-warning-ink",
  shutdown: "text-warning-ink",
  unknown: "text-muted",
};

interface AgentActivityProps {
  hasRun: boolean;
  activity: AgentInvocationActivity[];
  advisorLog: AdvisorLogEntry[];
  advisorUsage: string | undefined;
}

export function AgentActivity({ hasRun, activity, advisorLog, advisorUsage }: AgentActivityProps) {
  return (
    <div className="agent-activity-list">
      {activity.length > 0 && (
        <ul className="m-0 list-none p-0">
          {activity.map((invocation) => (
            <li key={invocation.id} className="bd-b">
              <div className="flex items-center gap-3 px-4 py-2.5 md:px-6">
                <StatusDot tone={statusTone[invocation.status]} pulse={invocation.status === "running"} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <strong className="truncate text-sm font-medium text-ink">{agentRoleLabel(invocation.role)}</strong>
                    {invocation.advisor && <Badge tone="active" title="只读顾问：按需出场，不写代码">顾问</Badge>}
                  </div>
                  <small className="block truncate text-xs text-muted">
                    {invocation.profile} · {invocation.adapter}{invocation.model ? ` / ${invocation.model}` : ""}
                  </small>
                </div>
                <AgentState status={invocation.status} />
                <Timestamp value={invocation.updatedAt} />
              </div>
              {invocation.children.length > 0 && (
                <ul className="m-0 list-none bg-surface-2 p-0">
                  {invocation.children.map((child) => (
                    <li key={child.id} className="bd-t flex items-center gap-3 py-2 pl-7 pr-4 md:pl-10 md:pr-6">
                      <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <strong className="block truncate text-xs font-medium text-ink-2">{child.label}</strong>
                        <small className="block truncate text-2xs text-muted">
                          Codex 原生子代理 · {shortThreadId(child.threadId)}{child.model ? ` · ${child.model}` : ""}
                        </small>
                      </div>
                      <AgentState status={child.status} />
                      <Timestamp value={child.updatedAt} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {advisorLog.length > 0 && (
        <Card role="group" aria-label="架构顾问记录" className="m-4 overflow-hidden md:mx-6">
          <div className="flex items-center gap-2 bg-surface-2 px-4 py-2.5">
            <Compass aria-hidden className="size-3.5 text-accent-ink" />
            <strong className="text-xs font-semibold text-ink">架构顾问</strong>
            {advisorUsage && <span className="ml-auto text-2xs tabular-nums text-muted">{advisorUsage}</span>}
          </div>
          <ul className="m-0 list-none p-0">
            {advisorLog.map((entry) => (
              <li key={entry.sequence} className="bd-t flex items-start gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-xs font-medium text-ink">
                    {entry.jev ? "Jev 分流" : advisorTriggerLabel(entry.trigger)}{entry.taskId ? ` · ${entry.taskId}` : ""}
                  </strong>
                  <small
                    className={cn(
                      "mt-0.5 block text-xs leading-snug break-words",
                      entry.status === "failed" ? "text-danger-ink" : entry.status === "skipped" ? "text-warning-ink" : "text-muted",
                    )}
                  >
                    {advisorText(entry)}
                  </small>
                </div>
                <time className="mt-0.5 hidden shrink-0 text-2xs tabular-nums text-muted sm:block" dateTime={entry.occurredAt}>
                  {formatTimestamp(entry.occurredAt)}
                </time>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {hasRun && activity.length === 0 && <EmptyState size="inline" title="等待角色启动" hint="总控开始工作后，这里会显示每个角色的状态" />}
      {!hasRun && <EmptyState size="inline" title="选择运行后显示角色" />}
    </div>
  );
}

function advisorText(entry: AdvisorLogEntry): string {
  if (entry.jev) return jevEntryText(entry.jev);
  if (entry.status === "consulted" && entry.recommendation) {
    return `${advisorRecommendationLabel(entry.recommendation)}${entry.summary ? `：${entry.summary}` : ""}`;
  }
  if (entry.status === "skipped") return "已达本次运行的顾问次数上限，已跳过";
  return `顾问调用失败，已放行${entry.detail ? `：${entry.detail}` : ""}`;
}

function AgentState({ status }: { status: AgentDisplayStatus }) {
  return <span className={cn("w-12 shrink-0 text-right text-xs font-medium", statusText[status])}>{agentStatusLabel(status)}</span>;
}

function Timestamp({ value }: { value: string }) {
  return (
    <time className="hidden w-24 shrink-0 text-right text-2xs tabular-nums text-muted sm:block" dateTime={value}>
      {formatTimestamp(value)}
    </time>
  );
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}…` : threadId;
}
