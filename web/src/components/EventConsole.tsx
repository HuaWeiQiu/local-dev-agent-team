import { Activity, Bot, CornerDownRight, Download, Radio, TerminalSquare } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  agentRoleLabel,
  agentStatusLabel,
  deriveAgentActivity,
  type AgentDisplayStatus,
} from "../agent-activity";
import { formatTimestamp } from "../presentation";
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
  const outputEvents = useMemo(
    () => events.filter((event) => event.type === "agent.stdout" || event.type === "agent.stderr"),
    [events],
  );
  const outputText = useMemo(() => outputEvents.map(formatOutput).join(""), [outputEvents]);
  const agentActivity = useMemo(
    () => deriveAgentActivity(events, run?.status),
    [events, run?.status],
  );
  const activeAgents = useMemo(
    () => agentActivity.reduce(
      (count, invocation) => count
        + Number(isActiveAgent(invocation.status))
        + invocation.children.filter((child) => isActiveAgent(child.status)).length,
      0,
    ),
    [agentActivity],
  );

  useEffect(() => {
    if (tab === "output") {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [events, tab]);

  return (
    <section className="event-console" aria-label="运行事件和日志">
      <header>
        <div className="console-tabs" role="tablist">
          <button className={tab === "agents" ? "is-active" : ""} onClick={() => setTab("agents")} role="tab" aria-selected={tab === "agents"}>
            <Bot size={15} />Agent
            {agentActivity.length > 0 && <span>{activeAgents || agentActivity.length}</span>}
          </button>
          <button className={tab === "activity" ? "is-active" : ""} onClick={() => setTab("activity")} role="tab" aria-selected={tab === "activity"}>
            <Activity size={15} />活动
          </button>
          <button className={tab === "output" ? "is-active" : ""} onClick={() => setTab("output")} role="tab" aria-selected={tab === "output"}>
            <TerminalSquare size={15} />输出
            {outputEvents.length > 0 && <span>{outputEvents.length}</span>}
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
      <div className="console-body" ref={scrollRef}>
        {tab === "agents" ? (
          <div className="agent-activity-list">
            {agentActivity.map((invocation) => (
              <div className="agent-activity-group" key={invocation.id}>
                <div className="agent-activity-row">
                  <span className={`agent-state-dot is-${invocation.status}`} aria-hidden="true" />
                  <div className="agent-activity-identity">
                    <strong>{agentRoleLabel(invocation.role)}</strong>
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
            {run && agentActivity.length === 0 && <span className="console-empty">等待 Agent 启动</span>}
            {!run && <span className="console-empty">选择运行后显示 Agent</span>}
          </div>
        ) : tab === "activity" ? (
          <div className="activity-list">
            {[...(run?.history ?? [])].reverse().map((item, index) => (
              <div key={`${item.at}-${index}`}>
                <time>{formatTimestamp(item.at)}</time>
                <span className="activity-dot" />
                <strong>{item.status}</strong>
                <p>{item.message}</p>
              </div>
            ))}
            {!run && <span className="console-empty">选择运行后显示活动</span>}
          </div>
        ) : (
          <pre className="output-log">{outputEvents.length > 0 ? outputText : "等待 Agent 输出…"}</pre>
        )}
      </div>
    </section>
  );
});

function formatOutput(event: RunEvent): string {
  const payload = event.payload as { role?: unknown; profile?: unknown; chunk?: unknown };
  const stream = event.type === "agent.stderr" ? "stderr" : "stdout";
  const role = typeof payload.role === "string" ? payload.role : "agent";
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
