import { Suspense, lazy } from "react";
import type { ReactNode } from "react";
import type { useRunActions } from "../hooks/useRunActions";
import type { useRunEvents } from "../hooks/useRunEvents";
import type { MonitorPanel } from "../components/RunPage";
import { BoardPage } from "../components/BoardPage";
import { RunPage } from "../components/RunPage";
import type { ApprovalRequest, ProjectScope, PublicConfig, TaskRunState } from "../types";
import { LoadingPane } from "./shells";

const EvolutionWorkbench = lazy(() =>
  import("../components/EvolutionWorkbench").then((module) => ({ default: module.EvolutionWorkbench })),
);
const ExperienceWorkbench = lazy(() =>
  import("../components/ExperienceWorkbench").then((module) => ({ default: module.ExperienceWorkbench })),
);
const SettingsWorkbench = lazy(() =>
  import("../components/SettingsWorkbench").then((module) => ({ default: module.SettingsWorkbench })),
);
const StrategyComposer = lazy(() =>
  import("../components/StrategyComposer").then((module) => ({ default: module.StrategyComposer })),
);

type Monitor = ReturnType<typeof useRunEvents>;
type Actions = ReturnType<typeof useRunActions>;

export interface WorkspaceViewProps {
  mode: "monitor" | "design" | "evolution" | "experience" | "settings" | "project";
  monitorView: "board" | "run";
  config: PublicConfig | undefined;
  scope: ProjectScope | undefined;
  scopeKey: string | undefined;
  projectName: string | undefined;
  monitor: Monitor;
  busy: boolean;
  monitorPanel: MonitorPanel;
  demo: boolean;
  onNavigate(mode: "monitor" | "design" | "evolution" | "experience" | "settings" | "project"): void;
  onSaved(): void;
  onOpenProject(): void;
  onOpenGlobal(): void;
  onSelectRun(runId: string): void;
  onCreate(goal: string, strategy: string): void;
  onOpenCleanup(): void;
  onDeleteRun(runId: string): void;
  onLaunch(strategy: string): void;
  onMonitorPanelChange(panel: MonitorPanel): void;
  onReviewApproval(approval: ApprovalRequest): void;
  onSelectTask(task: TaskRunState | undefined): void;
  actions: Actions;
  onError(error: unknown): void;
}

/** The workspace body: one of the workbenches, the run monitor or the board. */
export function WorkspaceView(props: WorkspaceViewProps): ReactNode {
  return (
    <Suspense fallback={<LoadingPane />}>
      {mainView(props)}
    </Suspense>
  );
}

function mainView(props: WorkspaceViewProps): ReactNode {
  const { mode, monitorView } = props;
  if (mode === "settings") return <SettingsScreen {...props} />;
  if (mode === "project") return <ProjectSettingsScreen {...props} />;
  if (mode === "evolution") return <EvolutionScreen {...props} />;
  if (mode === "experience") return <ExperienceScreen {...props} />;
  if (mode === "design") return <DesignScreen {...props} />;
  if (monitorView === "run") return <RunScreen {...props} />;
  return <BoardScreen {...props} />;
}

function SettingsScreen({ scope, projectName, onOpenProject, onSaved }: WorkspaceViewProps) {
  return (
    <SettingsWorkbench
      pane="global"
      {...(scope ? { scope } : {})}
      {...(projectName ? { projectName } : {})}
      onOpenProject={onOpenProject}
      onSaved={onSaved}
    />
  );
}

function ProjectSettingsScreen({ scope, projectName, onOpenGlobal, onSaved }: WorkspaceViewProps) {
  return (
    <SettingsWorkbench
      pane="project"
      scope={scope!}
      {...(projectName ? { projectName } : {})}
      onOpenGlobal={onOpenGlobal}
      onSaved={onSaved}
    />
  );
}

function EvolutionScreen({ scope, scopeKey, config }: WorkspaceViewProps) {
  return <EvolutionWorkbench key={scopeKey} scope={scope!} config={config!} />;
}

function ExperienceScreen({ scope, scopeKey }: WorkspaceViewProps) {
  return <ExperienceWorkbench key={`experience:${scopeKey}`} scope={scope!} />;
}

function DesignScreen({ config, onLaunch, actions }: WorkspaceViewProps) {
  return (
    <StrategyComposer
      config={config!}
      onPreflight={actions.preflightBlueprint}
      onSave={actions.saveBlueprint}
      onDelete={actions.deleteBlueprint}
      onLaunch={onLaunch}
    />
  );
}

function RunScreen(props: WorkspaceViewProps) {
  return (
    <RunPage
      scope={props.scope}
      monitor={props.monitor}
      busy={props.busy}
      monitorPanel={props.monitorPanel}
      onMonitorPanelChange={props.onMonitorPanelChange}
      onReviewApproval={props.onReviewApproval}
      onSelectTask={props.onSelectTask}
      onExportEvents={props.actions.exportRunEvents}
      onReadArtifact={props.actions.readEvidenceArtifact}
      onRefreshUsage={() =>
        void props.monitor.refreshUsage().catch((requestError: unknown) => props.onError(requestError))
      }
    />
  );
}

function BoardScreen(props: WorkspaceViewProps) {
  return (
    <BoardPage
      runs={props.monitor.runs}
      config={props.config}
      scope={props.scope}
      selectedRunId={undefined}
      busy={props.busy}
      loading={!props.config}
      demo={props.demo}
      onOpenRun={props.onSelectRun}
      onCreate={props.onCreate}
      onCleanup={props.onOpenCleanup}
      onDeleteRun={props.onDeleteRun}
    />
  );
}
