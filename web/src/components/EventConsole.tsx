import { Activity, Bot, Compass, CornerDownRight, Download, Radio, TerminalSquare } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  agentRoleLabel,
  agentStatusLabel,
  deriveAdvisorLog,
  deriveAgentActivity,
  type AgentDisplayStatus,
} from "../agent-activity";
import {
  advisorRecommendationLabel,
  advisorTriggerLabel,
  formatTimestamp,
  jevEntryText,
} from "../presentation";
import { buildOutputLog, isOutputEvent } from "../output-log";
import {
  deriveTimeline,
  filterTimeline,
  timelineKindCounts,
  timelineKindLabels,
  type TimelineKind,
} from "../timeline";
import { EmptyState } from "./EmptyState";
import type { RunEvent, RunState } from "../types";

interface EventConsoleProps {
  run: RunState | undefined;
  events: RunEvent[];
  connected: boolean;
  exporting?: boolean;
  onExport(): void;
}

export const EventConsole = memo(function EventConsole({ run, events, connected, exporting, onExport }: EventConsoleProps) {
  const [tab, setTab] = useState<"agents" | "activity" | "output">("agents");
  const scrollRef = useRef<HTMLDivElement>(null);
  const outputCount = useMemo(() => events.filter(isOutputEvent).length, [events]);
  // The text is only built while the output tab is visible, and capped to the newest window.
  const outputLog = useMemo(
    () => (tab === "output" ? buildOutputLog(events, formatOutput) : undefined),
    [events, tab],
  );
  const agentActivity = useMemo(
    () => deriveAgentActivity(events, run?.status),
    [events, run?.status],
  );
  const advisorLog = useMemo(() => deriveAdvisorLog(events), [events]);
  const [kinds, setKinds] = useState<ReadonlySet<TimelineKind>>(new Set());
  const timeline = useMemo(() => deriveTimeline(run, events), [run, events]);
  const kindCounts = useMemo(() => timelineKindCounts(timeline), [timeline]);
  const visibleTimeline = useMemo(() => filterTimeline(timeline, kinds), [timeline, kinds]);
  const advisorUsage = run?.strategy.advisor?.enabled
    ? `${run.advisorConsultations ?? 0} / ${run.strategy.advisor.maxConsultationsPerRun}`
    : undefined;
  const activeAgents = useMemo(
    () => agentActivity.reduce(
      (count, invocation) => count
        + Number(isActiveAgent(invocation.status))
        + invocation.children.filter((child) => isActiveAgent(child.status)).length,
      0,
    ),
    [agentActivity],
  );

  const pinnedToBottom = useRef(true);

  useEffect(() => {
    if (tab === "output" && pinnedToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [outputLog, tab]);

  return (
    <section className="event-console" aria-label="运行事件和日志">
      <header>
        <div className="console-tabs" role="tablist">
          <button className={tab === "agents" ? "is-active" : ""} onClick={() => setTab("agents")} role="tab" aria-selected={tab === "agents"}>
            <Bot size={15} />角色
            {agentActivity.length > 0 && <span>{activeAgents || agentActivity.length}</span>}
          </button>
          <button className={tab === "activity" ? "is-active" : ""} onClick={() => setTab("activity")} role="tab" aria-selected={tab === "activity"}>
            <Activity size={15} />活动
          </button>
          <button className={tab === "output" ? "is-active" : ""} onClick={() => setTab("output")} role="tab" aria-selected={tab === "output"}>
            <TerminalSquare size={15} />输出
            {outputCount > 0 && <span>{outputCount}</span>}
          </button>
        </div>
        <div className="console-actions">
          <button
            className="icon-button compact"
            onClick={onExport}
            disabled={!run || exporting}
            aria-label="导出日志"
            title="导出当前运行的事件日志（NDJSON）"
          >
            <Download size={15} />
          </button>
          <span className={`stream-state ${connected ? "is-connected" : ""}`}>
            <Radio size={13} />{connected ? "实时" : "离线"}
          </span>
        </div>
      </header>
      <div
        className="console-body"
        ref={scrollRef}
        onScroll={(event) => {
          const body = event.currentTarget;
          pinnedToBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
        }}
      >
        {tab === "agents" ? (
          <div className="agent-activity-list">
            {agentActivity.map((invocation) => (
              <div className="agent-activity-group" key={invocation.id}>
                <div className="agent-activity-row">
                  <span className={`agent-state-dot is-${invocation.status}`} aria-hidden="true" />
                  <div className="agent-activity-identity">
                    <strong>
                      {agentRoleLabel(invocation.role)}
                      {invocation.advisor && <span className="advisor-tag" title="只读顾问：按需出场，不写代码">顾问</span>}
                    </strong>
                    <small>{invocation.profile} · {invocation.adapter}{invocation.model ? ` / ${invocation.model}` : ""}</small>
                  </div>
                  <AgentState status={invocation.status} />
                  <time>{formatTimestamp(invocation.updatedAt)}</time>
                </div>
                {invocation.children.map((child) => (
                  <div className="agent-activity-row is-child" key={child.id}>
                    <CornerDownRight size={14} aria-hidden="true" />
                    <div className="agent-activity-identity">
                      <strong>{child.label}</strong>
                      <small>Codex 原生子代理 · {shortThreadId(child.threadId)}{child.model ? ` · ${child.model}` : ""}</small>
                    </div>
                    <AgentState status={child.status} />
                    <time>{formatTimestamp(child.updatedAt)}</time>
                  </div>
                ))}
              </div>
            ))}
            {advisorLog.length > 0 && (
              <div className="advisor-log" aria-label="架构顾问记录">
                <div className="advisor-log-title">
                  <Compass size={14} aria-hidden="true" />
                  <strong>架构顾问</strong>
                  {advisorUsage && <span>{advisorUsage}</span>}
                </div>
                {advisorLog.map((entry) => (
                  <div className={`advisor-log-row is-${entry.status}`} key={entry.sequence}>
                    <div>
                      <strong>{entry.jev ? "Jev 分流" : advisorTriggerLabel(entry.trigger)}{entry.taskId ? ` · ${entry.taskId}` : ""}</strong>
                      <small>
                        {entry.jev
                          ? jevEntryText(entry.jev)
                          : entry.status === "consulted" && entry.recommendation
                          ? `${advisorRecommendationLabel(entry.recommendation)}${entry.summary ? `：${entry.summary}` : ""}`
                          : entry.status === "skipped"
                            ? "已达本次运行的顾问次数上限，已跳过"
                            : `顾问调用失败，已放行${entry.detail ? `：${entry.detail}` : ""}`}
                      </small>
                    </div>
                    <time>{formatTimestamp(entry.occurredAt)}</time>
                  </div>
                ))}
              </div>
            )}
            {run && agentActivity.length === 0 && <EmptyState size="inline" title="等待角色启动" hint="总控开始工作后，这里会显示每个角色的状态" />}
            {!run && <EmptyState size="inline" title="选择运行后显示角色" />}
          </div>
        ) : tab === "activity" ? (
          <div className="activity-timeline">
            {run && timeline.length > 0 && (
              <div className="timeline-filters" role="group" aria-label="活动类型筛选">
                <button
                  type="button"
                  className={kinds.size === 0 ? "is-active" : ""}
                  aria-pressed={kinds.size === 0}
                  onClick={() => setKinds(new Set())}
                >
                  全部<span>{timeline.length}</span>
                </button>
                {(Object.keys(timelineKindLabels) as TimelineKind[])
                  .filter((kind) => kindCounts[kind] > 0)
                  .map((kind) => (
                    <button
                      type="button"
                      key={kind}
                      className={kinds.has(kind) ? "is-active" : ""}
                      aria-pressed={kinds.has(kind)}
                      onClick={() => setKinds(toggleKind(kinds, kind))}
                    >
                      {timelineKindLabels[kind]}<span>{kindCounts[kind]}</span>
                    </button>
                  ))}
              </div>
            )}
            <ol className="activity-list">
              {visibleTimeline.map((entry) => (
                <li key={entry.key} className={`timeline-row is-${entry.tone}`}>
                  <time>{formatTimestamp(entry.at)}</time>
                  <span className="activity-dot" aria-hidden="true" />
                  <div>
                    <strong>{entry.title}</strong>
                    {entry.detail && <p>{entry.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
            {!run && <EmptyState size="inline" title="选择运行后显示活动" />}
            {run && timeline.length === 0 && <EmptyState size="inline" title="还没有活动记录" />}
          </div>
        ) : (
          <pre className="output-log">
            {outputLog && outputLog.omittedEvents > 0 && (
              <span className="output-log-notice">
                {`… 已省略较早的 ${outputLog.omittedEvents} 条输出，仅显示最近内容；点击右上角导出可获取完整日志\n`}
              </span>
            )}
            {outputLog && outputLog.eventCount > 0 ? outputLog.text : "等待角色输出…"}
          </pre>
        )}
      </div>
    </section>
  );
});

function toggleKind(current: ReadonlySet<TimelineKind>, kind: TimelineKind): ReadonlySet<TimelineKind> {
  const next = new Set(current);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}

function formatOutput(event: RunEvent): string {
  const payload = event.payload as { role?: unknown; profile?: unknown; chunk?: unknown };
  const stream = event.type === "agent.stderr" ? "stderr" : "stdout";
  const role = agentRoleLabel(typeof payload.role === "string" ? payload.role : "agent");
  const profile = typeof payload.profile === "string" ? `/${payload.profile}` : "";
  const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
  return `[${formatTimestamp(event.occurredAt)}] ${role}${profile} ${stream}\n${chunk}`;
}

function AgentState({ status }: { status: AgentDisplayStatus }) {
  return <span className={`agent-state is-${status}`}>{agentStatusLabel(status)}</span>;
}

function isActiveAgent(status: AgentDisplayStatus): boolean {
  return status === "pending" || status === "running";
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}…` : threadId;
}
