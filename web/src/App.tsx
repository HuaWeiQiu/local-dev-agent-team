import {
  BookMarked,
  FolderCog,
  FolderSync,
  LayoutGrid,
  Monitor,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getWorkspace } from "./api";
import { laneOf } from "./board";
import type { MonitorPanel } from "./components/RunPage";
import { useDesktopProject } from "./hooks/useDesktopProject";
import { useDesktopSettings } from "./hooks/useDesktopSettings";
import { useOnboarding } from "./hooks/useOnboarding";
import { useRunActions } from "./hooks/useRunActions";
import { latestPendingApproval, useRunEvents } from "./hooks/useRunEvents";
import { useThemeMode } from "./hooks/useThemeMode";
import { runActionErrorMessage } from "./presentation";
import type { WorkspaceMode } from "./shell/nav";
import type { TaskRunState } from "./types";
import { AppChrome } from "./app/chrome";
import {
  detectDesktopShell,
  earlyPanelFor,
  paletteGroupsOf,
  scopeKeyOf,
  scopeOf,
  shortcutFor,
} from "./app/model";
import { AppLoadingShell } from "./app/shells";

export default function App({ demo = false }: { demo?: boolean }) {
  const [workspace, setWorkspace] = useState<Awaited<ReturnType<typeof getWorkspace>>>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherStrategy, setLauncherStrategy] = useState<string>();
  const [launcherGoal, setLauncherGoal] = useState<string>();
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("monitor");
  const [monitorView, setMonitorView] = useState<"board" | "run">("board");
  const [monitorPanel, setMonitorPanel] = useState<MonitorPanel>("overview");
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [desktopShell] = useState(detectDesktopShell);

  const theme = useThemeMode();
  const scope = useMemo(() => scopeOf(workspace, selectedProjectId), [selectedProjectId, workspace]);
  const scopeKey = scopeKeyOf(scope);

  const monitor = useRunEvents(scope, {
    evidenceVisible: monitorPanel === "evidence",
    usageVisible: monitorPanel === "usage",
  });
  const { config, runs, run, connected, error, setError, setSelectedRunId, setSelectedTaskId } = monitor;

  const actions = useRunActions({
    scope,
    monitor,
    setMonitorPanel,
    setMonitorView,
    setWorkspaceMode,
    setLauncherOpen,
    setLauncherStrategy,
  });
  const { roleDefaults, cliInventory, showCliPicker, refreshDesktopSettings } = useDesktopSettings(scope);
  const addDesktopProject = useDesktopProject({ desktopShell, setBusy: actions.setBusy, setError });
  const onboarding = useOnboarding(scope);

  useEffect(() => {
    void getWorkspace()
      .then((nextWorkspace) => {
        setWorkspace(nextWorkspace);
        setSelectedProjectId(nextWorkspace.defaultProjectId);
      })
      .catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));
  }, [setError]);

  const openLauncher = useCallback(
    (strategy?: string, goal?: string) => {
      setError(undefined);
      setLauncherStrategy(strategy);
      setLauncherGoal(goal);
      setLauncherOpen(true);
      void refreshDesktopSettings();
    },
    [refreshDesktopSettings, setError],
  );

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

  const handleSelectRun = useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
      setMonitorPanel(earlyPanelFor(runs.find((item) => item.id === runId)));
      setMonitorView("run");
      setWorkspaceMode("monitor");
      setNavOpen(false);
    },
    [runs, setSelectedRunId],
  );

  const handleSelectTask = useCallback(
    (task: TaskRunState | undefined) => setSelectedTaskId(task?.task.id),
    [setSelectedTaskId],
  );

  const selectProject = useCallback(
    (projectId: string) => {
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
    },
    [actions, closeLauncher, monitor],
  );

  useShortcuts({ enabled: Boolean(config), openLauncher, setPaletteOpen });

  const attentionCount = useMemo(
    () => runs.filter((item) => laneOf(item.status) === "attention").length,
    [runs],
  );

  const paletteGroups = useMemo(
    () =>
      paletteGroupsOf({
        workspace,
        config,
        runs,
        onNewRun: () => openLauncher(),
        onOnboarding: onboarding.reopen,
        onCleanup: () => actions.openCleanup(),
        onCycleTheme: theme.cycleTheme,
        navigate,
        onSelectRun: handleSelectRun,
        onSelectProject: selectProject,
        icons: {
          plus: <Plus />,
          shield: <ShieldCheck />,
          trash: <Trash2 />,
          monitor: <Monitor />,
          grid: <LayoutGrid />,
          workflow: <Workflow />,
          sparkles: <Sparkles />,
          book: <BookMarked />,
          folderCog: <FolderCog />,
          settings: <Settings2 />,
          folderSync: <FolderSync />,
        },
      }),
    [
      actions,
      config,
      handleSelectRun,
      navigate,
      onboarding.reopen,
      openLauncher,
      runs,
      selectProject,
      theme.cycleTheme,
      workspace,
    ],
  );

  if (!workspace || !selectedProjectId) {
    return <AppLoadingShell error={error} />;
  }

  const selectedProject = workspace.projects.find((project) => project.id === selectedProjectId);

  return (
    <AppChrome
      model={{
        workspace,
        selectedProjectId,
        selectedProjectName: selectedProject?.name,
        mode: workspaceMode,
        monitorView,
        monitorPanel,
        config,
        scope,
        scopeKey,
        monitor,
        actions,
        onboarding,
        theme,
        busy: actions.busy,
        run,
        error,
        demo,
        desktopShell,
        navOpen,
        paletteOpen,
        launcherOpen,
        launcherStrategy,
        launcherGoal,
        roleDefaults,
        cliInventory,
        showCliPicker,
        connected,
        attentionCount,
        paletteGroups,
        pendingApproval: latestPendingApproval(run),
        handlers: {
          navigate,
          selectProject,
          selectRun: handleSelectRun,
          selectTask: handleSelectTask,
          openLauncher,
          closeLauncher,
          openProject: () => navigate("project"),
          openGlobal: () => navigate("settings"),
          openCleanup: actions.openCleanup,
          deleteRun: (runId: string) => void actions.handleDeleteRun(runId),
          refreshSettings: () => void refreshDesktopSettings(),
          refreshUsage: () =>
            void monitor
              .refreshUsage()
              .catch((requestError: unknown) => setError(runActionErrorMessage(requestError))),
          addProject: () => void addDesktopProject(),
          cycleTheme: theme.cycleTheme,
          setNavOpen,
          setPaletteOpen,
          setMonitorView,
          setMonitorPanel,
          setError,
        },
      }}
    />
  );
}

/** Global shortcuts: ⌘K opens the palette, "N" starts a new run. */
function useShortcuts(input: {
  enabled: boolean;
  openLauncher(): void;
  setPaletteOpen(updater: (open: boolean) => boolean): void;
}): void {
  const { enabled, openLauncher, setPaletteOpen } = input;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = shortcutFor(event);
      if (shortcut === "palette") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (shortcut === "launcher" && enabled) {
        event.preventDefault();
        openLauncher();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, openLauncher, setPaletteOpen]);
}
