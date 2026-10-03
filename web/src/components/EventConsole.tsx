import { Activity, Bot, Download, Radio, TerminalSquare } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { agentRoleLabel, deriveAdvisorLog, deriveAgentActivity, type AgentDisplayStatus } from "../agent-activity";
import { formatTimestamp } from "../presentation";
import { buildOutputLog, isOutputEvent } from "../output-log";
import { deriveTimeline, filterTimeline, timelineKindCounts, type TimelineKind } from "../timeline";
import type { RunEvent, RunState } from "../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ActivityTimeline } from "./run/ActivityTimeline";
import { AgentActivity } from "./run/AgentActivity";

type ConsoleTab = "agents" | "activity" | "output";

const panelClass = "min-h-full outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent-line)]";

interface EventConsoleProps {
  run: RunState | undefined;
  events: RunEvent[];
  connected: boolean;
  exporting?: boolean;
  onExport(): void;
}

export const EventConsole = memo(function EventConsole({ run, events, connected, exporting, onExport }: EventConsoleProps) {
  const [tab, setTab] = useState<ConsoleTab>("agents");
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
    <Tabs asChild value={tab} onValueChange={(value) => setTab(value as ConsoleTab)}>
      <section aria-label="运行事件和日志" className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
        <header className="bd-b flex items-center justify-between gap-2 px-2 md:px-4">
          <TabsList aria-label="日志视图" className="min-w-0 gap-0 border-b-0">
            <TabsTrigger value="agents" className="h-11 shrink-0 px-2.5 max-sm:[&>svg]:hidden sm:px-3">
              <Bot />角色
              {agentActivity.length > 0 && <Badge className="px-1.5 tabular-nums">{activeAgents || agentActivity.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="activity" className="h-11 shrink-0 px-2.5 max-sm:[&>svg]:hidden sm:px-3">
              <Activity />活动
            </TabsTrigger>
            <TabsTrigger value="output" className="h-11 shrink-0 px-2.5 max-sm:[&>svg]:hidden sm:px-3">
              <TerminalSquare />输出
              {outputCount > 0 && <Badge className="px-1.5 tabular-nums">{outputCount}</Badge>}
            </TabsTrigger>
          </TabsList>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onExport}
              disabled={!run || exporting}
              aria-label="导出日志"
              title="导出当前运行的事件日志（NDJSON）"
            >
              <Download />
            </Button>
            <Badge tone={connected ? "success" : "neutral"}>
              <Radio className="size-3" aria-hidden />{connected ? "实时" : "离线"}
            </Badge>
          </div>
        </header>
        <div
          ref={scrollRef}
          className={cn("scroll-thin min-h-0 flex-1 overflow-auto", tab === "output" && "bg-[var(--terminal-bg)]")}
          onScroll={(event) => {
            const body = event.currentTarget;
            pinnedToBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
          }}
        >
          <TabsContent value="agents" className={panelClass}>
            <AgentActivity hasRun={Boolean(run)} activity={agentActivity} advisorLog={advisorLog} advisorUsage={advisorUsage} />
          </TabsContent>
          <TabsContent value="activity" className={panelClass}>
            <ActivityTimeline
              hasRun={Boolean(run)}
              entries={timeline}
              visible={visibleTimeline}
              kinds={kinds}
              kindCounts={kindCounts}
              onKindsChange={setKinds}
            />
          </TabsContent>
          <TabsContent value="output" className={cn(panelClass, "flex flex-col")}>
            <pre className="output-log m-0 flex-1 whitespace-pre-wrap break-words bg-[var(--terminal-bg)] p-3.5 font-mono text-2xs leading-[1.7] text-[var(--terminal-ink)] min-[801px]:px-5 min-[801px]:py-[18px] min-[801px]:text-xs">
              {outputLog && outputLog.omittedEvents > 0 && (
                <span className="italic text-[var(--terminal-muted)]">
                  {`… 已省略较早的 ${outputLog.omittedEvents} 条输出，仅显示最近内容；点击右上角导出可获取完整日志\n`}
                </span>
              )}
              {outputLog && outputLog.eventCount > 0 ? outputLog.text : <span className="text-[var(--terminal-muted)]">等待角色输出…</span>}
            </pre>
          </TabsContent>
        </div>
      </section>
    </Tabs>
  );
});

function formatOutput(event: RunEvent): string {
  const payload = event.payload as { role?: unknown; profile?: unknown; chunk?: unknown };
  const stream = event.type === "agent.stderr" ? "stderr" : "stdout";
  const role = agentRoleLabel(typeof payload.role === "string" ? payload.role : "agent");
  const profile = typeof payload.profile === "string" ? `/${payload.profile}` : "";
  const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
  return `[${formatTimestamp(event.occurredAt)}] ${role}${profile} ${stream}\n${chunk}`;
}

function isActiveAgent(status: AgentDisplayStatus): boolean {
  return status === "pending" || status === "running";
}
