import { FileCheck2, Gauge, LayoutDashboard, PanelRight, ScrollText, Workflow } from "lucide-react";
import { useMemo } from "react";
import { deriveAgentActivity } from "../agent-activity";
import { latestPendingApproval } from "../hooks/useRunEvents";
import type { RunMonitor } from "../hooks/useRunEvents";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { deriveLiveStatus } from "../live-status";
import { strategyDisplayName } from "../presentation";
import { formatRelative } from "../time";
import type { ApprovalRequest, EvidenceFilePreview, TaskRunState } from "../types";
import { cn } from "../ui/cn";
import { RunStatusPill } from "../ui/status";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { ApprovalCard } from "./ApprovalCard";
import { DagCanvas } from "./DagCanvas";
import { EventConsole } from "./EventConsole";
import { EvidenceCenter } from "./EvidenceCenter";
import { RunLiveBar } from "./RunLiveBar";
import { RunOverview } from "./RunOverview";
import { StageStepper } from "./StageStepper";
import { TaskInspector } from "./TaskInspector";
import { UsagePanel } from "./UsagePanel";

export type MonitorPanel = "overview" | "details" | "graph" | "activity" | "evidence" | "usage";

interface RunPageProps {
  monitor: RunMonitor;
  busy: boolean;
  monitorPanel: MonitorPanel;
  onMonitorPanelChange(panel: MonitorPanel): void;
  onReviewApproval(approval: ApprovalRequest): void;
  onSelectTask(task: TaskRunState): void;
  onExportEvents(): Promise<void>;
  onReadArtifact(path: string): Promise<EvidenceFilePreview>;
  onRefreshUsage(): void;
}

const tabs: Array<{ value: MonitorPanel; label: string; icon: typeof Workflow }> = [
  { value: "overview", label: "概览", icon: LayoutDashboard },
  { value: "graph", label: "任务图", icon: Workflow },
  { value: "details", label: "详情", icon: PanelRight },
  { value: "activity", label: "活动日志", icon: ScrollText },
  { value: "evidence", label: "交付证据", icon: FileCheck2 },
  { value: "usage", label: "用量", icon: Gauge },
];

export function RunPage({
  monitor,
  busy,
  monitorPanel,
  onMonitorPanelChange,
  onReviewApproval,
  onSelectTask,
  onExportEvents,
  onReadArtifact,
  onRefreshUsage,
}: RunPageProps) {
  const { selectedRunId, run, selectedTaskId, events, connected, evidence, evidenceLoading, usageReport, usageLoading } = monitor;
  const wide = useMediaQuery("(min-width: 1100px)");
  const selectedTask = useMemo(() => run?.tasks.find((task) => task.task.id === selectedTaskId), [run?.tasks, selectedTaskId]);
  const liveStatus = useMemo(() => deriveLiveStatus(run, deriveAgentActivity(events, run?.status)), [run, events]);
  const pendingApproval = useMemo(() => latestPendingApproval(run), [run]);
  const done = run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;
  const showInspector = monitorPanel === "graph";

  if (!run) {
    return (
      <section aria-label="运行工作台" className="grid h-full place-items-center text-sm text-muted">
        <span role="status">{selectedRunId ? "正在加载运行…" : "选择一个运行"}</span>
      </section>
    );
  }

  return (
    <section aria-label="运行工作台" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="bd-b bg-surface px-4 pt-4 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusPill status={run.status} />
          <span className="text-xs text-muted">
            {strategyDisplayName(run.strategy.name)} · {done}/{run.tasks.length} 任务完成 · 创建于 {formatRelative(run.createdAt)}
          </span>
        </div>
        <h2 className="m-0 mt-1.5 line-clamp-2 text-xl font-semibold leading-snug tracking-tight text-ink" title={run.goal}>{run.goal}</h2>
        <div className="mt-3.5">
          <StageStepper run={run} />
        </div>
        <Tabs value={monitorPanel} onValueChange={(value) => onMonitorPanelChange(value as MonitorPanel)} className="mt-2">
          <TabsList role="tablist" aria-label="运行视图" className="scroll-thin -mb-px overflow-x-auto border-b-0">
            {tabs.filter((tab) => wide ? tab.value !== "details" : true).map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="shrink-0">
                <Icon />{label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      {(liveStatus?.running || liveStatus?.pendingApprovals || pendingApproval) && (
        <div className="flex flex-col gap-2.5 px-4 pt-3.5 md:px-6">
          {liveStatus && <RunLiveBar status={liveStatus} onOpenActivity={() => onMonitorPanelChange("activity")} />}
          {pendingApproval && <ApprovalCard run={run} approval={pendingApproval} busy={busy} onReview={() => onReviewApproval(pendingApproval)} />}
        </div>
      )}

      <div className={cn("grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]", showInspector && wide ? "grid-cols-[minmax(0,1fr)_348px]" : "grid-cols-1")}>
        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] [&>*]:col-start-1 [&>*]:row-start-1">
          <div className={cn("min-h-0", monitorPanel !== "overview" && "hidden")}>
            <RunOverview
              run={run}
              events={events}
              onSelectTask={(task) => {
                onSelectTask(task);
                onMonitorPanelChange("graph");
              }}
              onOpenActivity={() => onMonitorPanelChange("activity")}
            />
          </div>
          {!wide && (
            <div className={cn("min-h-0 overflow-hidden [&>aside]:h-full [&>aside]:border-l-0", monitorPanel !== "details" && "hidden")}>
              <TaskInspector run={run} task={selectedTask} />
            </div>
          )}
          <div className={cn("run-panel", monitorPanel === "graph" && "is-active")}>
            {/* React Flow fits its viewport on mount, so it must mount while visible. */}
            {monitorPanel === "graph" && (
              <DagCanvas run={run} selectedTaskId={selectedTaskId} onSelectTask={(task) => { onSelectTask(task); if (!wide) onMonitorPanelChange("details"); }} />
            )}
          </div>
          <div className={cn("run-panel", monitorPanel === "activity" && "is-active")}>
            <EventConsole run={run} events={events} connected={connected} exporting={busy} onExport={() => void onExportEvents()} />
          </div>
          <div className={cn("run-panel", monitorPanel === "evidence" && "is-active")}>
            <EvidenceCenter run={run} evidence={evidence} loading={evidenceLoading} onReadArtifact={onReadArtifact} />
          </div>
          <div className={cn("run-panel", monitorPanel === "usage" && "is-active")}>
            <UsagePanel report={usageReport} loading={usageLoading} selectedRunId={selectedRunId} onRefresh={onRefreshUsage} />
          </div>
        </div>
        {showInspector && wide && <TaskInspector run={run} task={selectedTask} />}
      </div>

    </section>
  );
}
