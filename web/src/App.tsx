import { isTauri } from "@tauri-apps/api/core";
import { BookMarked, FolderCog, FolderSync, LayoutGrid, Monitor, Plus, Settings2, Sparkles, Trash2, Workflow } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { getWorkspace } from "./api";
import { laneOf } from "./board";
import { BoardPage } from "./components/BoardPage";
import { RunActionDialog } from "./components/RunActionDialog";
import { RunCleanupDialog } from "./components/RunCleanupDialog";
import { RunLauncher } from "./components/RunLauncher";
import { RunPage, type MonitorPanel } from "./components/RunPage";
import { useDesktopProject } from "./hooks/useDesktopProject";
import { useDesktopSettings } from "./hooks/useDesktopSettings";
import { useRunActions } from "./hooks/useRunActions";
import { latestPendingApproval, useRunEvents } from "./hooks/useRunEvents";
import { useThemeMode } from "./hooks/useThemeMode";
import { preferredMonitorPanel, runActionErrorMessage, runStatusLabel, summarizeGoal } from "./presentation";
import { CommandPalette, type PaletteGroup } from "./shell/CommandPalette";
import { workspaceTitles, type WorkspaceMode } from "./shell/nav";
import { RunActions } from "./shell/RunActions";
import { Sidebar } from "./shell/Sidebar";
import { TopBar } from "./shell/TopBar";
import type { ProjectScope, TaskRunState, WorkspaceInfo } from "./types";
import { TooltipProvider } from "./ui/tooltip";

// Secondary workbenches load on demand so the run monitor ships a smaller first chunk.
const EvolutionWorkbench = lazy(() =>
  import("./components/EvolutionWorkbench").then((module) => ({ default: module.EvolutionWorkbench })),
);
const ExperienceWorkbench = lazy(() =>
  import("./components/ExperienceWorkbench").then((module) => ({ default: module.ExperienceWorkbench })),
);
const SettingsWorkbench = lazy(() =>
  import("./components/SettingsWorkbench").then((module) => ({ default: module.SettingsWorkbench })),
);
const StrategyComposer = lazy(() =>
  import("./components/StrategyComposer").then((module) => ({ default: module.StrategyComposer })),
);

export default function App({ demo = false }: { demo?: boolean }) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherStrategy, setLauncherStrategy] = useState<string>();
  const [launcherGoal, setLauncherGoal] = useState<string>();
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("monitor");
  const [monitorView, setMonitorView] = useState<"board" | "run">("board");
  const [monitorPanel, setMonitorPanel] = useState<MonitorPanel>("overview");
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [desktopShell] = useState(() => {
    try {
      return isTauri();
    } catch {
      return false;
    }
  });
  const { themeMode, cycleTheme } = useThemeMode();
  const scope = useMemo<ProjectScope | undefined>(
    () => workspace && selectedProjectId
      ? { mode: workspace.mode, projectId: selectedProjectId }
      : undefined,
    [selectedProjectId, workspace],
  );
  const scopeKey = scope ? `${scope.mode}:${scope.projectId}` : undefined;

  // 运行监控数据 + SSE 事件流（项目级/选中 run 级订阅、flush 去重、刷新触发）
  const monitor = useRunEvents(scope, {
    evidenceVisible: monitorPanel === "evidence",
    usageVisible: monitorPanel === "usage",
  });
  const { config, runs, run, connected, error, setError, setSelectedRunId, setSelectedTaskId } = monitor;
  // 运行 mutation（create/cancel/retry/delete/审批/继续/清理/蓝图）与 busy 状态
  const actions = useRunActions({
    scope,
    monitor,
    setMonitorPanel,
    setMonitorView,
    setWorkspaceMode,
    setLauncherOpen,
    setLauncherStrategy,
  });
  const { busy, runAction, cleanupOpen, cleanupPreview, cleanupError } = actions;
  const { roleDefaults, cliInventory, showCliPicker, refreshDesktopSettings } = useDesktopSettings(scope);
  const addDesktopProject = useDesktopProject({ desktopShell, setBusy: actions.setBusy, setError });

  useEffect(() => {
    void getWorkspace()
      .then((nextWorkspace) => {
        setWorkspace(nextWorkspace);
        setSelectedProjectId(nextWorkspace.defaultProjectId);
      })
      .catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));
  }, [setError]);

  const openLauncher = useCallback((strategy?: string, goal?: string) => {
    setError(undefined);
    setLauncherStrategy(strategy);
    setLauncherGoal(goal);
    setLauncherOpen(true);
    void refreshDesktopSettings();
  }, [refreshDesktopSettings, setError]);

  const closeLauncher = useCallback(() => {
    setLauncherOpen(false);
    setLauncherStrategy(undefined);
    setLauncherGoal(undefined);
  }, []);

  const navigate = useCallback((mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    if (mode === "monitor") setMonitorView("board");
    setNavOpen(false);
  }, []);

  const handleSelectRun = useCallback((runId: string) => {
    const summary = runs.find((item) => item.id === runId);
    const early = summary
      ? preferredMonitorPanel({
          status: summary.status,
          tasks: Object.values(summary.taskCounts).some((count) => count > 0) ? [{}] : [],
          ...(summary.error ? { error: summary.error } : {}),
        })
      : "graph";
    setSelectedRunId(runId);
    setMonitorPanel(early === "activity" ? "activity" : "overview");
    setMonitorView("run");
    setWorkspaceMode("monitor");
    setNavOpen(false);
  }, [runs, setSelectedRunId]);

  const handleSelectTask = useCallback((task: TaskRunState) => {
    setSelectedTaskId(task.task.id);
  }, [setSelectedTaskId]);

  const selectProject = useCallback((projectId: string) => {
    closeLauncher();
    actions.setRunAction(undefined);
    actions.setCleanupOpen(false);
    actions.setCleanupPreview(undefined);
    actions.setCleanupError(undefined);
    monitor.resetRunScope();
    setSelectedProjectId(projectId);
    setWorkspaceMode("monitor");
    setMonitorView("board");
    setMonitorPanel("overview");
    setNavOpen(false);
  }, [actions, closeLauncher, monitor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);
      if (event.key === "n" && !event.metaKey && !event.ctrlKey && !event.altKey && !typing && !document.querySelector("[role=dialog]")) {
        event.preventDefault();
        if (config) openLauncher();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [config, openLauncher]);

  const pendingApproval = latestPendingApproval(run);
  const attentionCount = useMemo(() => runs.filter((item) => laneOf(item.status) === "attention").length, [runs]);

  const paletteGroups = useMemo<PaletteGroup[]>(() => {
    if (!workspace) return [];
    const goTo = (mode: WorkspaceMode) => () => navigate(mode);
    return [
      {
        heading: "操作",
        items: [
          ...(config ? [{ id: "new-run", label: "新建运行", hint: "N", icon: <Plus />, run: () => openLauncher() }] : []),
          { id: "cleanup", label: "清理本地运行历史", icon: <Trash2 />, keywords: ["清理", "删除"], run: () => actions.openCleanup() },
          { id: "theme", label: "切换主题", icon: <Monitor />, keywords: ["深色", "浅色", "dark", "light"], run: cycleTheme },
        ],
      },
      {
        heading: "页面",
        items: [
          { id: "go-board", label: "看板", icon: <LayoutGrid />, run: goTo("monitor") },
          ...(config
            ? [
                { id: "go-design", label: "策略编排", icon: <Workflow />, run: goTo("design") },
                { id: "go-evolution", label: "演进工作台", icon: <Sparkles />, run: goTo("evolution") },
                { id: "go-experience", label: "经验库", icon: <BookMarked />, run: goTo("experience") },
              ]
            : []),
          { id: "go-project", label: "项目设置", icon: <FolderCog />, run: goTo("project") },
          { id: "go-settings", label: "全局设置", icon: <Settings2 />, run: goTo("settings") },
        ],
      },
      {
        heading: "运行",
        items: runs.slice(0, 40).map((item) => ({
          id: `run-${item.id}`,
          label: summarizeGoal(item.goal, 60),
          hint: runStatusLabel(item.status),
          keywords: [item.id, item.status],
          run: () => handleSelectRun(item.id),
        })),
      },
      {
        heading: "项目",
        items: workspace.projects.length > 1
          ? workspace.projects.map((project) => ({
              id: `project-${project.id}`,
              label: `切换到 ${project.name}`,
              icon: <FolderSync />,
              run: () => selectProject(project.id),
            }))
          : [],
      },
    ];
  }, [actions, config, cycleTheme, handleSelectRun, navigate, openLauncher, runs, selectProject, workspace]);

  if (!workspace || !selectedProjectId) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <div className="flex flex-col items-center gap-3 text-center">
          <span
            aria-hidden
            className="size-9 rounded-xl motion-safe:animate-pulse"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          />
          <strong className="text-base font-semibold tracking-tight text-ink">Agent Team</strong>
          <span className="max-w-sm text-sm text-muted" role="status">{error ?? "连接控制服务…"}</span>
        </div>
      </div>
    );
  }

  const selectedProject = workspace.projects.find((project) => project.id === selectedProjectId);
  const inRun = workspaceMode === "monitor" && monitorView === "run";
  const heading = workspaceTitles[workspaceMode];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="ui flex h-dvh min-h-0 bg-background text-ink" style={{ backgroundImage: "var(--glow)", backgroundRepeat: "no-repeat" }}>
        <Sidebar
          workspace={workspace}
          selectedProjectId={selectedProjectId}
          mode={workspaceMode}
          hasConfig={Boolean(config)}
          hasScope={Boolean(scope)}
          attentionCount={attentionCount}
          connected={connected}
          demo={demo}
          themeMode={themeMode}
          desktopShell={desktopShell}
          busy={busy}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          onNavigate={navigate}
          onSelectProject={selectProject}
          onAddProject={() => void addDesktopProject()}
          onCreate={() => openLauncher()}
          onCycleTheme={cycleTheme}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {demo && (
            <div className="flex items-center justify-center gap-2 bg-info-soft px-3 py-1 text-xs text-info-ink">
              正在查看内置演示数据，所有操作只发生在浏览器内存里。
              <a className="font-medium underline" href={`${window.location.pathname}`}>退出演示</a>
            </div>
          )}
          <TopBar
            title={inRun && run ? summarizeGoal(run.goal, 72) : heading.title}
            {...(inRun ? {} : { hint: workspaceMode === "monitor" || !selectedProject ? heading.hint : `${selectedProject.name} · ${heading.hint}` })}
            {...(inRun ? { onBack: () => setMonitorView("board") } : {})}
            navOpen={navOpen}
            onOpenNav={() => setNavOpen(true)}
            actions={
              inRun && run ? (
                <RunActions
                  run={run}
                  busy={busy}
                  pendingApproval={pendingApproval}
                  onReviewApproval={(approval) => actions.setRunAction({ mode: "approval", approval })}
                  onResume={() => actions.setRunAction({ mode: "resume" })}
                  onPublish={() => void actions.publish()}
                  onPause={() => actions.setRunAction({ mode: "pause" })}
                  onCancel={() => void actions.cancel()}
                  onRetry={() => void actions.retry()}
                />
              ) : undefined
            }
          />
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted" role="status" aria-live="polite">正在加载…</div>}>
              {workspaceMode === "settings" ? (
                <SettingsWorkbench
                  pane="global"
                  {...(scope ? { scope } : {})}
                  {...(selectedProject?.name ? { projectName: selectedProject.name } : {})}
                  onOpenProject={() => navigate("project")}
                  onSaved={() => void refreshDesktopSettings()}
                />
              ) : workspaceMode === "project" && scope ? (
                <SettingsWorkbench
                  pane="project"
                  scope={scope}
                  {...(selectedProject?.name ? { projectName: selectedProject.name } : {})}
                  onOpenGlobal={() => navigate("settings")}
                  onSaved={() => void refreshDesktopSettings()}
                />
              ) : workspaceMode === "evolution" && config && scope ? (
                <EvolutionWorkbench key={scopeKey} scope={scope} config={config} />
              ) : workspaceMode === "experience" && scope ? (
                <ExperienceWorkbench key={`experience:${scopeKey}`} scope={scope} />
              ) : workspaceMode === "design" && config ? (
                <StrategyComposer
                  config={config}
                  onPreflight={actions.preflightBlueprint}
                  onSave={actions.saveBlueprint}
                  onDelete={actions.deleteBlueprint}
                  onLaunch={(strategy) => openLauncher(strategy)}
                />
              ) : monitorView === "run" ? (
                <RunPage
                  monitor={monitor}
                  busy={busy}
                  monitorPanel={monitorPanel}
                  onMonitorPanelChange={setMonitorPanel}
                  onReviewApproval={(approval) => actions.setRunAction({ mode: "approval", approval })}
                  onSelectTask={handleSelectTask}
                  onExportEvents={actions.exportRunEvents}
                  onReadArtifact={actions.readEvidenceArtifact}
                  onRefreshUsage={() => void monitor.refreshUsage().catch((requestError: unknown) => setError(runActionErrorMessage(requestError)))}
                />
              ) : (
                <BoardPage
                  runs={runs}
                  config={config}
                  selectedRunId={undefined}
                  busy={busy}
                  loading={!config}
                  demo={demo}
                  onOpenRun={handleSelectRun}
                  onCreate={(goal, strategy) => openLauncher(strategy, goal)}
                  onCleanup={actions.openCleanup}
                  onDeleteRun={(runId) => void actions.handleDeleteRun(runId)}
                />
              )}
            </Suspense>
          </main>
        </div>

        {error && !launcherOpen && (
          <div
            role="alert"
            className="bd fixed bottom-4 right-4 z-[70] flex max-w-md items-start gap-3 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-ink shadow-pop motion-safe:animate-[rise-in_160ms_ease-out]"
          >
            <span className="flex-1 leading-snug">{error}</span>
            <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-base leading-none text-danger-ink" onClick={() => setError(undefined)} aria-label="关闭错误">×</button>
          </div>
        )}
        {config && (
          <RunLauncher
            open={launcherOpen}
            config={config}
            {...(scope ? { scope } : {})}
            {...(launcherStrategy ? { initialStrategy: launcherStrategy } : {})}
            {...(launcherGoal ? { initialGoal: launcherGoal } : {})}
            busy={busy}
            error={error}
            roleDefaults={roleDefaults}
            showCliPicker={showCliPicker}
            {...(cliInventory ? { inventory: cliInventory } : {})}
            onClose={closeLauncher}
            onSubmit={actions.create}
          />
        )}
        <RunActionDialog
          mode={runAction?.mode}
          {...(runAction?.approval ? { approval: runAction.approval } : {})}
          {...(run ? { run } : {})}
          busy={busy}
          {...(error ? { error } : {})}
          onClose={() => actions.setRunAction(undefined)}
          onSubmit={actions.submitRunAction}
        />
        <RunCleanupDialog
          open={cleanupOpen}
          preview={cleanupPreview}
          busy={busy}
          error={cleanupError}
          onPreview={actions.previewCleanup}
          onConfirm={actions.confirmCleanup}
          onResetPreview={() => { actions.setCleanupPreview(undefined); actions.setCleanupError(undefined); }}
          onClose={() => { actions.setCleanupOpen(false); actions.setCleanupPreview(undefined); actions.setCleanupError(undefined); }}
        />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={paletteGroups} />
      </div>
    </TooltipProvider>
  );
}
