import { useMediaQuery } from "../hooks/useMediaQuery";
import type { RunMonitor } from "../hooks/useRunEvents";
import type { ApprovalRequest, EvidenceFilePreview, ProjectScope, TaskRunState } from "../types";
import { AgentsPanel } from "./AgentsPanel";
import { DagCanvas } from "./DagCanvas";
import { EventConsole } from "./EventConsole";
import { EvidenceCenter } from "./EvidenceCenter";
import { InsightsPanel } from "./InsightsPanel";
import { RunOverview } from "./RunOverview";
import { TaskInspector } from "./TaskInspector";
import { UsagePanel } from "./UsagePanel";
import { useRunPageHandlers, useRunPageState } from "./run-page/hooks";
import type { RunPageHandlers, RunPageState } from "./run-page/hooks";
import { EmptyRun, Panel, RunAlerts, RunGrid, RunPageHeader } from "./run-page/sections";

export type MonitorPanel =
  | "overview"
  | "details"
  | "graph"
  | "agents"
  | "activity"
  | "evidence"
  | "usage"
  | "insights";

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

export function RunPage(props: RunPageProps) {
  const { monitor, scope, monitorPanel, busy } = props;
  const wide = useMediaQuery("(min-width: 1100px)");
  const state = useRunPageState({ scope, monitor, monitorPanel });
  const handlers = useRunPageHandlers({
    wide,
    setSelectedStageId: state.setSelectedStageId,
    setSelectedModuleId: state.setSelectedModuleId,
    onSelectTask: props.onSelectTask,
    onMonitorPanelChange: props.onMonitorPanelChange,
  });

  if (!monitor.run) {
    return <EmptyRun hasSelection={Boolean(monitor.selectedRunId)} />;
  }
  const run = monitor.run;
  const screen = { ...props, run, state, handlers, wide };

  return (
    <section aria-label="运行工作台" className="flex h-full min-h-0 min-w-0 flex-col">
      <RunPageHeader
        run={run}
        state={state}
        panel={monitorPanel}
        wide={wide}
        onPanelChange={props.onMonitorPanelChange}
        onSelectStage={handlers.selectStageFromStepper}
      />
      <RunAlerts
        state={state}
        run={run}
        busy={busy}
        pendingApproval={state.pendingApproval}
        onOpenActivity={handlers.openActivity}
        onOpenAgents={() => props.onMonitorPanelChange("agents")}
        onReview={() => state.pendingApproval && props.onReviewApproval(state.pendingApproval)}
      />
      <RunGrid
        showInspector={state.showInspector}
        wide={wide}
        inspector={<Inspector screen={screen} className="bd-l" />}
      >
        <OverviewPanel screen={screen} />
        <DetailsPanel screen={screen} />
        <GraphPanel screen={screen} />
        <Panel active={monitorPanel === "agents"}>
          <AgentsPanel events={monitor.events} controls={state.liveAgents} runActive={state.runActive} />
        </Panel>
        <Panel active={monitorPanel === "activity"}>
          <EventConsole
            run={run}
            events={monitor.events}
            connected={monitor.connected}
            exporting={busy}
            onExport={() => void props.onExportEvents()}
          />
        </Panel>
        <Panel active={monitorPanel === "evidence"}>
          <EvidenceCenter
            run={run}
            evidence={monitor.evidence}
            loading={monitor.evidenceLoading}
            onReadArtifact={props.onReadArtifact}
          />
        </Panel>
        <Panel active={monitorPanel === "insights"}>
          <InsightsPanel insights={state.insights} />
        </Panel>
        <Panel active={monitorPanel === "usage"}>
          <UsagePanel
            report={monitor.usageReport}
            loading={monitor.usageLoading}
            selectedRunId={monitor.selectedRunId}
            onRefresh={props.onRefreshUsage}
          />
        </Panel>
      </RunGrid>
    </section>
  );
}

type Screen = RunPageProps & {
  run: NonNullable<RunMonitor["run"]>;
  state: RunPageState;
  handlers: RunPageHandlers;
  wide: boolean;
};

function Inspector({ screen, className }: { screen: Screen; className?: string }) {
  const { state, handlers, run } = screen;
  return (
    <TaskInspector
      run={run}
      task={state.selectedTask}
      {...(state.stageBrief && !state.selectedModuleId ? { stage: state.stageBrief } : {})}
      {...(state.selectedModuleId ? { moduleId: state.selectedModuleId } : {})}
      onSelectModule={state.setSelectedModuleId}
      onClearModule={handlers.clearModule}
      onSelectTask={handlers.openTask}
      onLoadDiff={state.insights.loadDiff}
      {...(className ? { className } : {})}
    />
  );
}

function OverviewPanel({ screen }: { screen: Screen }) {
  const { monitorPanel, state, handlers, run, monitor } = screen;
  return (
    <Panel active={monitorPanel === "overview"}>
      <RunOverview
        run={run}
        events={monitor.events}
        headline={state.insights.explanation?.headline}
        onSelectTask={handlers.openTaskFromOverview}
        onOpenActivity={handlers.openActivity}
        onOpenArchitecture={handlers.openArchitecture}
      />
    </Panel>
  );
}

function DetailsPanel({ screen }: { screen: Screen }) {
  const { monitorPanel, wide } = screen;
  if (wide) return null;
  return (
    <Panel active={monitorPanel === "details"}>
      <Inspector screen={screen} />
    </Panel>
  );
}

function GraphPanel({ screen }: { screen: Screen }) {
  const { monitorPanel, state, handlers, run, monitor } = screen;
  if (monitorPanel !== "graph") return null;
  return (
    <Panel active>
      <DagCanvas
        run={run}
        events={monitor.events}
        selectedTaskId={monitor.selectedTaskId}
        {...(state.activeStageId ? { selectedStageId: state.activeStageId } : {})}
        {...(state.selectedModuleId ? { selectedModuleId: state.selectedModuleId } : {})}
        onSelectTask={handlers.openTaskInDag}
        onSelectStage={handlers.openStageInDag}
        onSelectModule={handlers.openModuleInDag}
        onClearModule={handlers.clearModule}
      />
    </Panel>
  );
}
