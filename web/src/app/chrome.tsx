import type { ReactNode } from "react";
import type { MonitorPanel } from "../components/RunPage";
import { runActionErrorMessage, summarizeGoal } from "../presentation";
import { OnboardingWizard } from "../components/OnboardingWizard";
import { RunActionDialog } from "../components/RunActionDialog";
import { RunCleanupDialog } from "../components/RunCleanupDialog";
import { RunLauncher } from "../components/RunLauncher";
import type { useOnboarding } from "../hooks/useOnboarding";
import type { useRunActions } from "../hooks/useRunActions";
import type { useRunEvents } from "../hooks/useRunEvents";
import type { useThemeMode } from "../hooks/useThemeMode";
import type { PaletteGroup } from "../shell/CommandPalette";
import { CommandPalette } from "../shell/CommandPalette";
import { workspaceTitles, type WorkspaceMode } from "../shell/nav";
import { RunActions } from "../shell/RunActions";
import { Sidebar } from "../shell/Sidebar";
import { TopBar } from "../shell/TopBar";
import type {
  ApprovalRequest,
  CliInventory,
  ProjectScope,
  PublicConfig,
  RoleBindingInput,
  RunState,
  TaskRunState,
  WorkspaceInfo,
} from "../types";
import { TooltipProvider } from "../ui/tooltip";
import { DemoBanner, ErrorToast } from "./shells";
import { WorkspaceView } from "./WorkspaceView";

type Monitor = ReturnType<typeof useRunEvents>;
type Actions = ReturnType<typeof useRunActions>;
type Onboarding = ReturnType<typeof useOnboarding>;
type Theme = ReturnType<typeof useThemeMode>;

export interface AppChromeModel {
  workspace: WorkspaceInfo;
  selectedProjectId: string;
  selectedProjectName: string | undefined;
  mode: WorkspaceMode;
  monitorView: "board" | "run";
  monitorPanel: MonitorPanel;
  config: PublicConfig | undefined;
  scope: ProjectScope | undefined;
  scopeKey: string | undefined;
  monitor: Monitor;
  actions: Actions;
  onboarding: Onboarding;
  theme: Theme;
  busy: boolean;
  run: RunState | undefined;
  error: string | undefined;
  demo: boolean;
  desktopShell: boolean;
  navOpen: boolean;
  paletteOpen: boolean;
  launcherOpen: boolean;
  launcherStrategy: string | undefined;
  launcherGoal: string | undefined;
  roleDefaults: Record<string, RoleBindingInput> | undefined;
  cliInventory: CliInventory | undefined;
  showCliPicker: boolean;
  connected: boolean;
  attentionCount: number;
  paletteGroups: PaletteGroup[];
  pendingApproval: ApprovalRequest | undefined;
  handlers: {
    navigate(mode: WorkspaceMode): void;
    selectProject(projectId: string): void;
    selectRun(runId: string): void;
    selectTask(task: TaskRunState | undefined): void;
    openLauncher(strategy?: string, goal?: string): void;
    closeLauncher(): void;
    openProject(): void;
    openGlobal(): void;
    openCleanup(): void;
    deleteRun(runId: string): void;
    refreshSettings(): void;
    refreshUsage(): void;
    addProject(): void;
    cycleTheme(): void;
    setNavOpen(open: boolean): void;
    setPaletteOpen(open: boolean): void;
    setMonitorView(view: "board" | "run"): void;
    setMonitorPanel(panel: MonitorPanel): void;
    setError(error: string | undefined): void;
  };
}

/** Everything the shell renders below the providers: sidebar, top bar, body and dialogs. */
export function AppChrome({ model }: { model: AppChromeModel }) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="ui flex h-dvh min-h-0 bg-background text-ink">
        <Sidebar
          workspace={model.workspace}
          selectedProjectId={model.selectedProjectId}
          mode={model.mode}
          hasConfig={Boolean(model.config)}
          hasScope={Boolean(model.scope)}
          attentionCount={model.attentionCount}
          connected={model.connected}
          demo={model.demo}
          themeMode={model.theme.themeMode}
          desktopShell={model.desktopShell}
          busy={model.busy}
          open={model.navOpen}
          onClose={() => model.handlers.setNavOpen(false)}
          onNavigate={model.handlers.navigate}
          onSelectProject={model.handlers.selectProject}
          onAddProject={model.handlers.addProject}
          onCreate={() => model.handlers.openLauncher()}
          onCycleTheme={model.handlers.cycleTheme}
          onOpenPalette={() => model.handlers.setPaletteOpen(true)}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {model.demo && <DemoBanner />}
          <ChromeHeader model={model} />
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <WorkspaceView {...workspaceProps(model)} />
          </main>
        </div>
        {model.error && !model.launcherOpen && (
          <ErrorToast
            message={model.error}
            onDismiss={() => model.handlers.setError(undefined)}
          />
        )}
        <AppDialogs model={model} />
      </div>
    </TooltipProvider>
  );
}

function ChromeHeader({ model }: { model: AppChromeModel }) {
  const inRun = model.mode === "monitor" && model.monitorView === "run";
  const heading = workspaceTitles[model.mode];
  return (
    <TopBar
      title={inRun && model.run ? summarize(model.run) : heading.title}
      {...(inRun ? {} : { hint: hintFor(model.mode, model.selectedProjectName) })}
      {...(inRun ? { onBack: () => model.handlers.setMonitorView("board") } : {})}
      navOpen={model.navOpen}
      onOpenNav={() => model.handlers.setNavOpen(true)}
      actions={inRun && model.run ? <RunActionsFor model={model} /> : undefined}
    />
  );
}

function summarize(run: RunState): string {
  return summarizeGoal(run.goal, 72);
}

function hintFor(mode: WorkspaceMode, projectName: string | undefined): string {
  const heading = workspaceTitles[mode];
  if (mode === "monitor" || !projectName) return heading.hint;
  return `${projectName} · ${heading.hint}`;
}

function RunActionsFor({ model }: { model: AppChromeModel }) {
  const run = model.run!;
  return (
    <RunActions
      run={run}
      busy={model.busy}
      pendingApproval={model.pendingApproval}
      onReviewApproval={(approval) => model.actions.setRunAction({ mode: "approval", approval })}
      onResume={() => model.actions.setRunAction({ mode: "resume" })}
      onPublish={() => void model.actions.publish()}
      onPause={() => model.actions.setRunAction({ mode: "pause" })}
      onCancel={() => void model.actions.cancel()}
      onRetry={() => void model.actions.retry()}
    />
  );
}

function workspaceProps(model: AppChromeModel) {
  return {
    mode: model.mode,
    monitorView: model.monitorView,
    config: model.config,
    scope: model.scope,
    scopeKey: model.scopeKey,
    projectName: model.selectedProjectName,
    monitor: model.monitor,
    busy: model.busy,
    monitorPanel: model.monitorPanel,
    demo: model.demo,
    actions: model.actions,
    onNavigate: model.handlers.navigate,
    onSaved: model.handlers.refreshSettings,
    onOpenProject: model.handlers.openProject,
    onOpenGlobal: model.handlers.openGlobal,
    onSelectRun: model.handlers.selectRun,
    onCreate: (goal: string, strategy: string) => model.handlers.openLauncher(strategy, goal),
    onOpenCleanup: model.handlers.openCleanup,
    onDeleteRun: model.handlers.deleteRun,
    onLaunch: (strategy: string) => model.handlers.openLauncher(strategy),
    onMonitorPanelChange: model.handlers.setMonitorPanel,
    onReviewApproval: (approval: ApprovalRequest) =>
      model.actions.setRunAction({ mode: "approval", approval }),
    onSelectTask: model.handlers.selectTask,
    onError: (requestError: unknown) => model.handlers.setError(runActionErrorMessage(requestError)),
  };
}

function AppDialogs({ model }: { model: AppChromeModel }): ReactNode {
  return (
    <>
      <LauncherDialog model={model} />
      <RunActionDialogBound model={model} />
      <CleanupDialog model={model} />
      <OnboardingWizard
        open={model.onboarding.open && !model.launcherOpen}
        status={model.onboarding.status}
        busy={model.onboarding.busy}
        error={model.onboarding.error}
        onSave={model.onboarding.save}
        onSkip={model.onboarding.skip}
      />
      <CommandPalette
        open={model.paletteOpen}
        onOpenChange={model.handlers.setPaletteOpen}
        groups={model.paletteGroups}
      />
    </>
  );
}

function LauncherDialog({ model }: { model: AppChromeModel }): ReactNode {
  if (!model.config) return null;
  return (
      <RunLauncher
          open={model.launcherOpen}
          config={model.config}
          scope={model.scope}
          initialStrategy={model.launcherStrategy}
          initialGoal={model.launcherGoal}
          busy={model.busy}
          error={model.error}
          roleDefaults={model.roleDefaults}
          showCliPicker={model.showCliPicker}
          inventory={model.cliInventory}
          onClose={model.handlers.closeLauncher}
          onSubmit={model.actions.create}
      />
  );
}

function RunActionDialogBound({ model }: { model: AppChromeModel }): ReactNode {
  return (
      <RunActionDialog
        mode={model.actions.runAction?.mode}
        {...(model.actions.runAction?.approval
          ? { approval: model.actions.runAction.approval }
          : {})}
        {...(model.run ? { run: model.run } : {})}
        busy={model.busy}
        {...(model.error ? { error: model.error } : {})}
        onClose={() => model.actions.setRunAction(undefined)}
        onSubmit={model.actions.submitRunAction}
      />
  );
}

function CleanupDialog({ model }: { model: AppChromeModel }): ReactNode {
  return (
      <RunCleanupDialog
        open={model.actions.cleanupOpen}
        preview={model.actions.cleanupPreview}
        busy={model.busy}
        error={model.actions.cleanupError}
        onPreview={model.actions.previewCleanup}
        onConfirm={model.actions.confirmCleanup}
        onResetPreview={() => {
          model.actions.setCleanupPreview(undefined);
          model.actions.setCleanupError(undefined);
        }}
        onClose={() => {
          model.actions.setCleanupOpen(false);
          model.actions.setCleanupPreview(undefined);
          model.actions.setCleanupError(undefined);
        }}
      />
  );
}
