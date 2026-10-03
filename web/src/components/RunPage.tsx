import { Bot, CircleHelp, FileCheck2, Gauge, Lightbulb, LayoutDashboard, PanelRight, ScrollText, Workflow } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { currentStageId, describeStage, stageForTask } from "../architecture";
import type { StageId } from "../stages";
import { deriveAgentActivity } from "../agent-activity";
import { latestPendingApproval } from "../hooks/useRunEvents";
import type { RunMonitor } from "../hooks/useRunEvents";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { useRunInsights } from "../hooks/useRunInsights";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { deriveLiveStatus } from "../live-status";
import { activeRunStatuses, strategyDisplayName } from "../presentation";
import { formatRelative } from "../time";
import type { ApprovalRequest, EvidenceFilePreview, ProjectScope, TaskRunState } from "../types";
import { cn } from "../ui/cn";
import { RunStatusPill } from "../ui/status";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { AgentsPanel } from "./AgentsPanel";
import { ApprovalCard } from "./ApprovalCard";
import { DagCanvas } from "./DagCanvas";
import { EventConsole } from "./EventConsole";
import { EvidenceCenter } from "./EvidenceCenter";
import { InsightsPanel } from "./InsightsPanel";
import { RunLiveBar } from "./RunLiveBar";
import { RunOverview } from "./RunOverview";
import { StageStepper } from "./StageStepper";
import { TaskInspector } from "./TaskInspector";
import { UsagePanel } from "./UsagePanel";

export type MonitorPanel = "overview" | "details" | "graph" | "agents" | "activity" | "evidence" | "usage" | "insights";

interface RunPageProps {
  scope: ProjectScope | undefined;
  monitor: RunMonitor;
  busy: boolean;
  monitorPanel: MonitorPanel;
  onMonitorPanelChange(panel: MonitorPanel): void;
  onReviewApproval(approval: ApprovalRequest): void;
  onSelectTask(task: TaskRunState | undefined): void;
  onExportEvents(): Promise<void>;
  onReadArtifact(path: string): Promise<EvidenceFilePreview>;
  onRefreshUsage(): void;
}

const tabs: Array<{ value: MonitorPanel; label: string; icon: typeof Workflow }> = [
  { value: "overview", label: "概览", icon: LayoutDashboard },
  { value: "graph", label: "架构", icon: Workflow },
  { value: "details", label: "详情", icon: PanelRight },
  { value: "agents", label: "智能体", icon: Bot },
  { value: "activity", label: "活动日志", icon: ScrollText },
  { value: "evidence", label: "交付证据", icon: FileCheck2 },
  { value: "insights", label: "洞察", icon: Lightbulb },
  { value: "usage", label: "用量", icon: Gauge },
];

export function RunPage({
  scope,
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
  const [selectedStageId, setSelectedStageId] = useState<StageId | undefined>();
  const [selectedModuleId, setSelectedModuleId] = useState<string | undefined>();
  const activeStageId = selectedStageId ?? (run ? currentStageId(run) : undefined);
  const stageBrief = useMemo(
    () => (run && selectedStageId ? describeStage(run, selectedStageId, events) : undefined),
    [selectedStageId, events, run],
  );
  const liveStatus = useMemo(() => deriveLiveStatus(run, deriveAgentActivity(events, run?.status)), [run, events]);
  const pendingApproval = useMemo(() => latestPendingApproval(run), [run]);
  const done = run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;
  const showInspector = monitorPanel === "graph";
  const runActive = run ? activeRunStatuses.has(run.status) : false;
  const liveAgents = useLiveAgents(scope, selectedRunId, events, runActive);
  const insights = useRunInsights(scope, selectedRunId, run?.updatedAt, monitorPanel === "insights");
  const questionCount = liveAgents.agents.reduce((total, agent) => total + agent.questions.length, 0);

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
          <StageStepper
            run={run}
            {...(activeStageId ? { selectedStageId: activeStageId } : {})}
            onSelectStage={(id) => {
              setSelectedStageId(id);
              setSelectedModuleId(undefined);
              onSelectTask(undefined);
              onMonitorPanelChange("graph");
            }}
          />
        </div>
        <Tabs value={monitorPanel} onValueChange={(value) => onMonitorPanelChange(value as MonitorPanel)} className="mt-2">
          <TabsList role="tablist" aria-label="运行视图" className="scroll-thin -mb-px overflow-x-auto border-b-0">
            {tabs.filter((tab) => wide ? tab.value !== "details" : true).map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="shrink-0">
                <Icon />{label}
                {value === "agents" && liveAgents.agents.length > 0 ? (
                  <span className="ml-1 rounded-full bg-accent-soft px-1.5 text-2xs text-accent-ink">{liveAgents.agents.length}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      {(liveStatus?.running || liveStatus?.pendingApprovals || pendingApproval || questionCount > 0) && (
        <div className="flex flex-col gap-2.5 px-4 pt-3.5 md:px-6">
          {questionCount > 0 && (
            <button
              type="button"
              onClick={() => onMonitorPanelChange("agents")}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-solid border-warning/40 bg-warning-soft px-4 py-2.5 text-left text-sm font-medium text-warning-ink focus-ring"
            >
              <CircleHelp className="size-4" aria-hidden />
              {questionCount} 个智能体问题等你回答
              <span className="ml-auto text-xs font-normal underline">去回答</span>
            </button>
          )}
          {liveStatus && <RunLiveBar status={liveStatus} onOpenActivity={() => onMonitorPanelChange("activity")} />}
          {pendingApproval && <ApprovalCard run={run} approval={pendingApproval} busy={busy} onReview={() => onReviewApproval(pendingApproval)} />}
        </div>
      )}

      <div className={cn("grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]", showInspector && wide ? "grid-cols-[minmax(0,1fr)_348px]" : "grid-cols-1")}>
        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] [&>*]:col-start-1 [&>*]:row-start-1">
          <div className={cn("min-h-0", monitorPanel !== "overview" && "hidden")}>
            <RunOverview
              run={run}
              events={events}
              headline={insights.explanation?.headline}
              onSelectTask={(task) => {
                setSelectedStageId(stageForTask(task));
                setSelectedModuleId(undefined);
                onSelectTask(task);
                onMonitorPanelChange("graph");
              }}
              onOpenActivity={() => onMonitorPanelChange("activity")}
              onOpenArchitecture={() => {
                setSelectedModuleId(undefined);
                onSelectTask(undefined);
                onMonitorPanelChange("graph");
              }}
            />
          </div>
          {!wide && (
            <Panel active={monitorPanel === "details"}>
              <TaskInspector
                run={run}
                task={selectedTask}
                {...(stageBrief && !selectedModuleId ? { stage: stageBrief } : {})}
                {...(selectedModuleId ? { moduleId: selectedModuleId } : {})}
                onSelectModule={setSelectedModuleId}
                onSelectTask={(task) => {
                  setSelectedStageId(stageForTask(task));
                  setSelectedModuleId(undefined);
                  onSelectTask(task);
                }}
                onLoadDiff={insights.loadDiff}
              />
            </Panel>
          )}
          <Panel active={monitorPanel === "graph"}>
            {/* React Flow fits its viewport on mount, so it must mount while visible. */}
            {monitorPanel === "graph" && (
              <DagCanvas
                run={run}
                events={events}
                selectedTaskId={selectedTaskId}
                {...(activeStageId ? { selectedStageId: activeStageId } : {})}
                {...(selectedModuleId ? { selectedModuleId } : {})}
                onSelectTask={(task) => {
                  setSelectedStageId(stageForTask(task));
                  setSelectedModuleId(undefined);
                  onSelectTask(task);
                  if (!wide) onMonitorPanelChange("details");
                }}
                onSelectStage={(id) => {
                  setSelectedStageId(id);
                  setSelectedModuleId(undefined);
                  onSelectTask(undefined);
                  if (!wide) onMonitorPanelChange("details");
                }}
                onSelectModule={(id) => {
                  setSelectedModuleId(id);
                  onSelectTask(undefined);
                  if (!wide) onMonitorPanelChange("details");
                }}
              />
            )}
          </Panel>
          <Panel active={monitorPanel === "agents"}>
            <AgentsPanel events={events} controls={liveAgents} runActive={runActive} />
          </Panel>
          <Panel active={monitorPanel === "activity"}>
            <EventConsole run={run} events={events} connected={connected} exporting={busy} onExport={() => void onExportEvents()} />
          </Panel>
          <Panel active={monitorPanel === "evidence"}>
            <EvidenceCenter run={run} evidence={evidence} loading={evidenceLoading} onReadArtifact={onReadArtifact} />
          </Panel>
          <Panel active={monitorPanel === "insights"}>
            <InsightsPanel insights={insights} />
          </Panel>
          <Panel active={monitorPanel === "usage"}>
            <UsagePanel report={usageReport} loading={usageLoading} selectedRunId={selectedRunId} onRefresh={onRefreshUsage} />
          </Panel>
        </div>
        {showInspector && wide && (
          <TaskInspector
            run={run}
            task={selectedTask}
            {...(stageBrief && !selectedModuleId ? { stage: stageBrief } : {})}
            {...(selectedModuleId ? { moduleId: selectedModuleId } : {})}
            onSelectModule={setSelectedModuleId}
            onSelectTask={(task) => {
              setSelectedStageId(stageForTask(task));
              setSelectedModuleId(undefined);
              onSelectTask(task);
            }}
            onLoadDiff={insights.loadDiff}
            className="bd-l"
          />
        )}
      </div>

    </section>
  );
}

function Panel({ active, children }: { active: boolean; children: ReactNode }) {
  return <div className={cn("min-h-0 min-w-0 flex-col", active ? "flex" : "hidden")}>{children}</div>;
}
