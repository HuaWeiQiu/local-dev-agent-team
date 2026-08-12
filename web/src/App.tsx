import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Activity, Ban, BookMarked, Bot, CircleDot, FileCheck2, FolderPlus, Gauge, GitBranch, History, Monitor, Moon, Network, Plus, Radio, RotateCcw, Rows3, ScrollText, Settings2, ShieldCheck, Sparkles, Sun, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelRun,
  cleanupRuns,
  deleteRun,
  deleteStrategyBlueprint,
  downloadRunEvents,
  eventStreamUrl,
  getDesktopSettings,
  getEvidenceFile,
  getConfig,
  getRun,
  getRunEvidence,
  getRuns,
  getUsage,
  getWorkspace,
  preflightStrategyBlueprint,
  previewRunCleanup,
  respondApproval,
  resumeRun,
  retryRun,
  saveStrategyBlueprint,
  startRun,
} from "./api";
import { DagCanvas } from "./components/DagCanvas";
import { EventConsole } from "./components/EventConsole";
import { retainAgentMonitorEvents } from "./agent-activity";
import { EvidenceCenter } from "./components/EvidenceCenter";
import { EvolutionWorkbench } from "./components/EvolutionWorkbench";
import { ExperienceWorkbench } from "./components/ExperienceWorkbench";
import { RunCleanupDialog } from "./components/RunCleanupDialog";
import { RunLauncher } from "./components/RunLauncher";
import { RunActionDialog } from "./components/RunActionDialog";
import { RunRail } from "./components/RunRail";
import { SettingsWorkbench } from "./components/SettingsWorkbench";
import { StrategyComposer } from "./components/StrategyComposer";
import { RunStatusBadge } from "./components/StatusBadge";
import { TaskInspector } from "./components/TaskInspector";
import { UsagePanel } from "./components/UsagePanel";
import { activeRunStatuses, humanizeFailure, preferredMonitorPanel, runActionErrorMessage, strategyDisplayName, summarizeGoal } from "./presentation";
import { applyTheme, getInitialTheme, nextThemeMode, themeModeLabel, type ThemeMode } from "./theme";
import type {
  ProjectScope,
  ApprovalRequest,
  CliInventory,
  EvidenceFilePreview,
  PublicConfig,
  RoleBindingInput,
  RunEvent,
  RunCleanupPreview,
  RunEvidence,
  RunState,
  RunSummary,
  StartRunInput,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
  TaskRunState,
  UsageReport,
  WorkspaceInfo,
} from "./types";

const retryableStatuses = new Set(["blocked", "cancelled", "interrupted"]);

interface DesktopShellStatus {
  state: string;
  message: string;
  projectName?: string;
  technicalDetail?: string;
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [config, setConfig] = useState<PublicConfig>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [run, setRun] = useState<RunState>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [evidence, setEvidence] = useState<RunEvidence>();
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherStrategy, setLauncherStrategy] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [runAction, setRunAction] = useState<{
    mode: "approval" | "resume";
    approval?: ApprovalRequest;
  }>();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState<RunCleanupPreview>();
  const [cleanupError, setCleanupError] = useState<string>();
  const [error, setError] = useState<string>();
  const [workspaceMode, setWorkspaceMode] = useState<"monitor" | "design" | "evolution" | "experience" | "settings">("monitor");
  const [monitorPanel, setMonitorPanel] = useState<"graph" | "activity" | "evidence" | "usage">("graph");
  const [mobileView, setMobileView] = useState<"runs" | "design" | "evolution" | "experience" | "settings" | "flow" | "details" | "logs" | "evidence" | "usage">("flow");
  const [usageReport, setUsageReport] = useState<UsageReport>();
  const [usageLoading, setUsageLoading] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getInitialTheme());
  const [roleDefaults, setRoleDefaults] = useState<Record<string, RoleBindingInput>>({});
  const [cliInventory, setCliInventory] = useState<CliInventory>();
  const [showCliPicker, setShowCliPicker] = useState(true);
  const [autoDetectOnFocus, setAutoDetectOnFocus] = useState(true);
  const [desktopShell] = useState(() => {
    try {
      return isTauri();
    } catch {
      return false;
    }
  });
  const refreshTimer = useRef<number | undefined>(undefined);
  const eventBuffer = useRef<RunEvent[]>([]);
  const eventFlushTimer = useRef<number | undefined>(undefined);
  const scope = useMemo<ProjectScope | undefined>(
    () => workspace && selectedProjectId
      ? { mode: workspace.mode, projectId: selectedProjectId }
      : undefined,
    [selectedProjectId, workspace],
  );
  const scopeKey = scope ? `${scope.mode}:${scope.projectId}` : undefined;
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const currentRunId = useRef(selectedRunId);
  currentRunId.current = selectedRunId;

  const refreshRuns = useCallback(async () => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    try {
      const nextRuns = await getRuns(scope);
      if (currentScopeKey.current !== requestedScope) return;
      setRuns(nextRuns);
      setSelectedRunId((current) => current && nextRuns.some((item) => item.id === current) ? current : nextRuns[0]?.id);
    } catch (requestError) {
      if (currentScopeKey.current === requestedScope) throw requestError;
    }
  }, [scope]);

  const refreshConfig = useCallback(async (): Promise<PublicConfig> => {
    if (!scope) throw new Error("当前项目尚未加载");
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    const nextConfig = await getConfig(scope);
    if (currentScopeKey.current !== requestedScope) {
      throw new Error("项目已切换，请重试");
    }
    setConfig(nextConfig);
    return nextConfig;
  }, [scope]);

  const refreshRun = useCallback(async (runId: string) => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    const isCurrent = () => currentScopeKey.current === requestedScope && currentRunId.current === runId;
    try {
      const nextRun = await getRun(scope, runId);
      // 切项目或切 run 后到达的陈旧响应直接丢弃，避免覆盖新选中的数据
      if (!isCurrent()) return;
      setRun(nextRun);
      setSelectedTaskId((current) => current && nextRun.tasks.some((task) => task.task.id === current) ? current : undefined);
    } catch (requestError) {
      if (!isCurrent()) return;
      if (requestError instanceof ApiError && requestError.status === 404) {
        // 运行已被删除/清理：清空选择并提示，而不是滞留旧数据
        setRun(undefined);
        setSelectedTaskId(undefined);
        setEvents([]);
        setSelectedRunId(undefined);
        setError("该运行已不存在，已从当前选择中移除。");
        void refreshRuns().catch(() => undefined);
        return;
      }
      throw requestError;
    }
  }, [refreshRuns, scope]);

  const refreshEvidence = useCallback(async (runId: string) => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    setEvidenceLoading(true);
    try {
      const nextEvidence = await getRunEvidence(scope, runId);
      if (currentScopeKey.current === requestedScope) setEvidence(nextEvidence);
    } finally {
      if (currentScopeKey.current === requestedScope) setEvidenceLoading(false);
    }
  }, [scope]);

  const refreshUsage = useCallback(async () => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    setUsageLoading(true);
    try {
      const nextUsage = await getUsage(scope);
      if (currentScopeKey.current === requestedScope) setUsageReport(nextUsage);
    } finally {
      if (currentScopeKey.current === requestedScope) setUsageLoading(false);
    }
  }, [scope]);

  const scheduleRefresh = useCallback((runId: string) => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      // SSE 触发的后台刷新：瞬时失败不弹全局 toast，下一轮事件会再触发
      void Promise.all([refreshRuns(), refreshRun(runId)]).catch(() => undefined);
    }, 80);
  }, [refreshRun, refreshRuns]);

  const cycleTheme = useCallback(() => {
    const next = nextThemeMode(themeMode);
    applyTheme(next);
    setThemeMode(next);
  }, [themeMode]);

  const resetRunScope = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    eventBuffer.current = [];
    window.clearTimeout(eventFlushTimer.current);
    eventFlushTimer.current = undefined;
    setConfig(undefined);
    setRuns([]);
    setSelectedRunId(undefined);
    setRun(undefined);
    setSelectedTaskId(undefined);
    setEvents([]);
    setEvidence(undefined);
    setUsageReport(undefined);
    setUsageLoading(false);
    setConnected(false);
    setError(undefined);
    setCleanupOpen(false);
    setCleanupPreview(undefined);
    setCleanupError(undefined);
  }, []);

  useEffect(() => {
    void getWorkspace()
      .then((nextWorkspace) => {
        setWorkspace(nextWorkspace);
        setSelectedProjectId(nextWorkspace.defaultProjectId);
      })
      .catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));
    return () => window.clearTimeout(refreshTimer.current);
  }, []);

  useEffect(() => {
    if (!scope) return;
    let active = true;
    resetRunScope();
    void Promise.all([getConfig(scope), getRuns(scope)])
      .then(([nextConfig, nextRuns]) => {
        if (!active) return;
        setConfig(nextConfig);
        setRuns(nextRuns);
        setSelectedRunId(nextRuns[0]?.id);
      })
      .catch((requestError: unknown) => {
        if (active) setError(runActionErrorMessage(requestError));
      });
    return () => {
      active = false;
    };
  }, [resetRunScope, scope]);

  useEffect(() => {
    if (!scope || !selectedRunId) {
      setRun(undefined);
      setEvents([]);
      setEvidence(undefined);
      return;
    }
    setRun(undefined);
    setSelectedTaskId(undefined);
    setEvents([]);
    setEvidence(undefined);
    void refreshRun(selectedRunId).catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));

    const source = new EventSource(eventStreamUrl(scope, selectedRunId));
    let active = true;
    let lastSequence = 0;
    source.onopen = () => {
      if (active) setConnected(true);
    };
    source.onerror = () => {
      if (active) setConnected(false);
    };
    // SSE 事件先进 ref 缓冲，~120ms 定时 flush，避免每条事件都触发全树重渲染
    const flushEvents = () => {
      eventFlushTimer.current = undefined;
      if (!active || eventBuffer.current.length === 0) return;
      // 按 sequence 去重兜底：重连续传/重放可能带重复事件，保留原有顺序
      const pending = eventBuffer.current.filter((event) => event.sequence > lastSequence);
      eventBuffer.current = [];
      if (pending.length === 0) return;
      lastSequence = pending.reduce((max, event) => Math.max(max, event.sequence), lastSequence);
      setEvents((current) => retainAgentMonitorEvents([...current, ...pending]));
    };
    source.onmessage = (message) => {
      if (!active) return;
      try {
        const event = JSON.parse(message.data) as RunEvent;
        eventBuffer.current.push(event);
        eventFlushTimer.current ??= window.setTimeout(flushEvents, 120);
        if (event.type === "run.updated" || event.type === "run.crashed") {
          scheduleRefresh(selectedRunId);
        }
      } catch {
        setError("收到无法解析的运行事件");
      }
    };
    return () => {
      active = false;
      source.close();
      setConnected(false);
      window.clearTimeout(eventFlushTimer.current);
      eventFlushTimer.current = undefined;
      eventBuffer.current = [];
    };
  }, [refreshRun, scheduleRefresh, scope, selectedRunId]);

  // 项目级事件流：任何 run（含未选中的）有事件都触发运行列表刷新
  useEffect(() => {
    if (!scope) return;
    const source = new EventSource(eventStreamUrl(scope));
    let active = true;
    let listTimer: number | undefined;
    source.onmessage = () => {
      if (!active) return;
      listTimer ??= window.setTimeout(() => {
        listTimer = undefined;
        // 后台刷新失败不打扰用户，下一条事件会再次触发
        void refreshRuns().catch(() => undefined);
      }, 150);
    };
    return () => {
      active = false;
      source.close();
      window.clearTimeout(listTimer);
    };
  }, [refreshRuns, scope]);

  useEffect(() => {
    const evidenceVisible = monitorPanel === "evidence" || mobileView === "evidence";
    if (!selectedRunId || !scope || !evidenceVisible) return;
    void refreshEvidence(selectedRunId).catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));
  }, [mobileView, monitorPanel, refreshEvidence, run?.updatedAt, scope, selectedRunId]);

  useEffect(() => {
    const usageVisible = monitorPanel === "usage" || mobileView === "usage";
    if (!scope || !usageVisible) return;
    void refreshUsage().catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));
  }, [mobileView, monitorPanel, refreshUsage, scope]);

  const selectedTask = useMemo(
    () => run?.tasks.find((task) => task.task.id === selectedTaskId),
    [run?.tasks, selectedTaskId],
  );
  const pendingApproval = latestPendingApproval(run);

  const create = async (input: StartRunInput): Promise<boolean> => {
    if (!scope) return false;
    setBusy(true);
    setError(undefined);
    try {
      const runId = await startRun(scope, input);
      setLauncherOpen(false);
      setLauncherStrategy(undefined);
      setSelectedRunId(runId);
      setMonitorPanel("activity");
      setMobileView("logs");
      setWorkspaceMode("monitor");
      await refreshRuns();
      return true;
    } catch (requestError) {
      // 启动失败：保留弹窗与用户输入，由调用方决定是否清空
      setError(runActionErrorMessage(requestError));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const preflightBlueprint = async (
    name: string,
    definition: StrategyBlueprintDefinition,
  ): Promise<StrategyBlueprintResult> => {
    if (!scope) throw new Error("当前项目尚未加载");
    return await preflightStrategyBlueprint(scope, name, definition);
  };

  const saveBlueprint = async (
    name: string,
    definition: StrategyBlueprintDefinition,
  ): Promise<StrategyBlueprintResult> => {
    if (!scope) throw new Error("当前项目尚未加载");
    const result = await saveStrategyBlueprint(scope, name, definition);
    await refreshConfig();
    return result;
  };

  const deleteBlueprint = async (name: string): Promise<void> => {
    if (!scope) throw new Error("当前项目尚未加载");
    await deleteStrategyBlueprint(scope, name);
    await refreshConfig();
  };

  const refreshDesktopSettings = useCallback(async () => {
    try {
      // Soft read: server invalidates cache when CLI config mtime fingerprint changes.
      const response = await getDesktopSettings();
      setRoleDefaults(response.settings.defaults.roles);
      setCliInventory(response.inventory);
      setShowCliPicker(response.settings.ui.showCliPickerInRunLauncher !== false);
      const auto = response.settings.ui.autoDetectCliConfig !== false
        && response.settings.ui.autoDetectOnFocus !== false;
      setAutoDetectOnFocus(auto);
    } catch {
      // Settings require desktop session; plain browser serve may 401 — ignore.
    }
  }, []);

  useEffect(() => {
    void refreshDesktopSettings();
  }, [refreshDesktopSettings]);

  // When user returns to the app after editing ~/.codex/config.toml etc., refresh inventory.
  // Respects settings → 「回到窗口时检测」; open launcher always refreshes (manual path).
  useEffect(() => {
    if (!autoDetectOnFocus) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshDesktopSettings();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [autoDetectOnFocus, refreshDesktopSettings]);

  const openLauncher = useCallback((strategy?: string) => {
    setError(undefined);
    setLauncherStrategy(strategy);
    setLauncherOpen(true);
    void refreshDesktopSettings();
  }, [refreshDesktopSettings]);

  /** Desktop only: pick a local folder and register it into the multi-project workspace. */
  const addDesktopProject = useCallback(async () => {
    if (!desktopShell) return;
    setBusy(true);
    setError(undefined);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择要接入的代码项目",
      });
      if (typeof selected !== "string") {
        return;
      }
      let status = await invoke<DesktopShellStatus>("desktop_open_project", {
        projectPath: selected,
      });
      if (status.state === "needsSetup") {
        const ok = window.confirm(
          `${status.message}\n\n路径：${selected}\n\n是否现在初始化 agent-team.yaml 并接入？`,
        );
        if (!ok) {
          // Restore previous multi-project workspace after a cancelled setup.
          await invoke<DesktopShellStatus>("desktop_retry");
          return;
        }
        status = await invoke<DesktopShellStatus>("desktop_initialize_project");
      }
      if (status.state === "error" || status.state === "busy") {
        setError(
          [status.message, status.technicalDetail].filter(Boolean).join("\n"),
        );
        return;
      }
      // ready/starting: native shell navigates to the new control session.
    } catch (requestError) {
      const detail = runActionErrorMessage(requestError);
      setError(
        /not found|Command .* not found/i.test(detail)
          ? "当前桌面端权限未覆盖工作台页面，无法添加项目。请安装最新桌面构建后重试。"
          : detail,
      );
    } finally {
      setBusy(false);
    }
  }, [desktopShell]);

  const openCleanup = useCallback(() => {
    setCleanupPreview(undefined);
    setCleanupError(undefined);
    setCleanupOpen(true);
  }, []);

  const handleDeleteRun = useCallback(async (runId: string) => {
    if (!scope) return;
    const target = runs.find((item) => item.id === runId);
    const label = target ? summarizeGoal(target.goal, 40) : runId;
    if (!window.confirm(`确定删除运行「${label}」？本地记录与证据将永久删除。`)) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await deleteRun(scope, runId);
      if (selectedRunId === runId) {
        setRun(undefined);
        setEvidence(undefined);
        setSelectedRunId(undefined);
        setEvents([]);
      }
      await refreshRuns();
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }, [refreshRuns, runs, scope, selectedRunId]);

  const handleSelectRun = useCallback((runId: string) => {
    const summary = runs.find((item) => item.id === runId);
    const panel = preferredMonitorPanel(
      summary
        ? {
            status: summary.status,
            tasks: Object.values(summary.taskCounts).some((count) => count > 0) ? [{}] : [],
            ...(summary.error ? { error: summary.error } : {}),
          }
        : undefined,
    );
    setSelectedRunId(runId);
    setMonitorPanel(panel);
    setMobileView(panel === "activity" ? "logs" : "flow");
  }, [runs]);

  const handleSelectTask = useCallback((task: TaskRunState) => {
    setSelectedTaskId(task.task.id);
    if (window.innerWidth <= 800) setMobileView("details");
  }, []);

  const cancel = async () => {
    if (!scope || !selectedRunId) return;
    setBusy(true);
    setError(undefined);
    try {
      await cancelRun(scope, selectedRunId);
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!scope || !selectedRunId) return;
    setBusy(true);
    setError(undefined);
    try {
      const runId = await retryRun(scope, selectedRunId);
      setSelectedRunId(runId);
      setMonitorPanel("activity");
      setMobileView("logs");
      await refreshRuns();
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const submitRunAction = async (input: {
    decision?: "approved" | "rejected";
    actor: string;
    reason: string;
  }) => {
    if (!scope || !selectedRunId || !runAction) return;
    setBusy(true);
    setError(undefined);
    try {
      if (runAction.mode === "approval") {
        if (!runAction.approval || !input.decision) return;
        await respondApproval(scope, selectedRunId, {
          requestId: runAction.approval.id,
          decision: input.decision,
          actor: input.actor,
          reason: input.reason,
        });
      } else {
        await resumeRun(scope, selectedRunId, {
          actor: input.actor,
          reason: input.reason,
        });
      }
      setRunAction(undefined);
      await Promise.all([refreshRuns(), refreshRun(selectedRunId)]);
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const previewCleanup = async (days: number) => {
    if (!scope) return;
    setBusy(true);
    setCleanupError(undefined);
    try {
      setCleanupPreview(await previewRunCleanup(scope, days));
    } catch (requestError) {
      setCleanupError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const confirmCleanup = async () => {
    if (!scope || !cleanupPreview) return;
    setBusy(true);
    setCleanupError(undefined);
    try {
      await cleanupRuns(scope, cleanupPreview.token);
      setCleanupOpen(false);
      setCleanupPreview(undefined);
      setRun(undefined);
      setEvidence(undefined);
      await refreshRuns();
    } catch (requestError) {
      setCleanupError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const readEvidenceArtifact = useCallback(async (artifactPath: string): Promise<EvidenceFilePreview> => {
    if (!scope || !selectedRunId) throw new Error("当前运行尚未加载");
    return await getEvidenceFile(scope, selectedRunId, artifactPath);
  }, [scope, selectedRunId]);

  const exportRunEvents = useCallback(async () => {
    if (!scope || !selectedRunId) return;
    setBusy(true);
    setError(undefined);
    try {
      await downloadRunEvents(scope, selectedRunId);
    } catch (requestError) {
      setError(runActionErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }, [scope, selectedRunId]);

  if (!workspace || !selectedProjectId) {
    return <div className="boot-screen"><CircleDot className="boot-mark" size={28} /><strong>Agent Team</strong><span>{error ?? "连接控制服务"}</span></div>;
  }

  const selectedProject = workspace.projects.find((project) => project.id === selectedProjectId);
  const completedTasks = run?.tasks.filter((task) => ["passed", "merged"].includes(task.status)).length ?? 0;

  return (
    <div className={`app-shell mode-${workspaceMode}`} data-mobile-view={mobileView}>
      <aside className="app-navigation" aria-label="主导航">
        <div className="product-symbol" title="Agent Team"><Bot size={23} /></div>
        <nav>
          <button
            className={workspaceMode === "monitor" ? "is-active" : ""}
            onClick={() => setWorkspaceMode("monitor")}
            aria-label="运行监控"
            title="运行监控"
          >
            <Activity size={20} /><span>运行</span>
          </button>
          <button
            className={workspaceMode === "design" ? "is-active" : ""}
            onClick={() => setWorkspaceMode("design")}
            aria-label="策略编排"
            title="策略编排"
            disabled={!config}
          >
            <Workflow size={20} /><span>编排</span>
          </button>
          <button
            className={workspaceMode === "evolution" ? "is-active" : ""}
            onClick={() => { setWorkspaceMode("evolution"); setMobileView("evolution"); }}
            aria-label="演进工作台"
            title="演进工作台"
            disabled={!config}
          >
            <Sparkles size={20} /><span>演进</span>
          </button>
          <button
            className={workspaceMode === "experience" ? "is-active" : ""}
            onClick={() => { setWorkspaceMode("experience"); setMobileView("experience"); }}
            aria-label="经验库"
            title="经验库"
            disabled={!config}
          >
            <BookMarked size={20} /><span>经验</span>
          </button>
          <button
            className={workspaceMode === "settings" ? "is-active" : ""}
            onClick={() => { setWorkspaceMode("settings"); setMobileView("settings"); }}
            aria-label="全局设置"
            title="全局设置 · CLI 与角色默认"
          >
            <Settings2 size={20} /><span>设置</span>
          </button>
        </nav>
        <span className={`navigation-stream ${connected ? "is-connected" : ""}`} title={connected ? "事件流已连接" : "事件流未连接"}>
          <Radio size={18} />
        </span>
      </aside>

      <header className="topbar">
        <div className="project-context">
          <span className="topbar-product">Agent Team</span>
          <span className="context-divider" />
          <label
            className="project-switcher"
            title={
              workspace.projects.length > 1
                ? "切换当前查看的项目"
                : "当前工作区只有 1 个已接入项目；可用「添加项目」接入更多本地仓库"
            }
          >
            <span className="project-switcher-label">
              项目 {workspace.connectedCount ?? workspace.projects.length}
              {workspace.registeredCount && workspace.registeredCount !== workspace.projects.length
                ? `/${workspace.registeredCount} 已接入`
                : " 已接入"}
            </span>
            <select
              aria-label="当前项目"
              value={selectedProjectId}
              disabled={busy || workspace.projects.length <= 1}
              onChange={(event) => {
                setLauncherOpen(false);
                setLauncherStrategy(undefined);
                setRunAction(undefined);
                resetRunScope();
                setSelectedProjectId(event.target.value);
                setWorkspaceMode("monitor");
                setMonitorPanel("graph");
                setMobileView("flow");
              }}
            >
              {workspace.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} ({project.defaultBranch})
                </option>
              ))}
            </select>
          </label>
          {desktopShell ? (
            <button
              type="button"
              className="button secondary project-add-button"
              onClick={() => void addDesktopProject()}
              disabled={busy}
              title="选择本地文件夹，接入为新项目"
              aria-label="添加项目"
            >
              <FolderPlus size={15} />
              <span>添加项目</span>
            </button>
          ) : (
            <span className="project-switcher-hint" title="网页模式请用 CLI：agent-team serve --workspace ...">
              网页模式请用工作区配置接入
            </span>
          )}
          <span className="project-branch"><GitBranch size={13} />{selectedProject?.defaultBranch}</span>
        </div>
        <div className="topbar-run">
          {workspaceMode === "design" ? <><span className="topbar-context-label">策略工作室</span><strong>拓扑与执行政策</strong></> : workspaceMode === "evolution" ? <><span className="topbar-context-label">演进工作台</span><strong>候选、预检与人工门禁</strong></> : workspaceMode === "experience" ? <><span className="topbar-context-label">经验库</span><strong>候选晋升与跨项目共享</strong></> : run ? (
            <>
              <RunStatusBadge status={run.status} />
              <strong>{run.goal}</strong>
            </>
          ) : <span>本地 Agent 控制台</span>}
        </div>
        <div className="topbar-actions">
          {workspaceMode !== "evolution" && workspaceMode !== "experience" && (
            <button className="button secondary mobile-evolution-entry" onClick={() => { setWorkspaceMode("evolution"); setMobileView("evolution"); }} disabled={!config} aria-label="演进工作台" title="演进工作台"><Sparkles size={17} /><span>演进</span></button>
          )}
          {workspaceMode !== "experience" && (
            <button className="button secondary mobile-evolution-entry" onClick={() => { setWorkspaceMode("experience"); setMobileView("experience"); }} disabled={!config} aria-label="经验库" title="经验库"><BookMarked size={17} /><span>经验</span></button>
          )}
          {workspaceMode === "monitor" && pendingApproval && (
            <button
              className="button secondary"
              onClick={() => setRunAction({ mode: "approval", approval: pendingApproval })}
              disabled={busy}
              title="处理审批"
            >
              <ShieldCheck size={16} /><span>处理审批</span>
            </button>
          )}
          {workspaceMode === "monitor" && run?.status === "interrupted" && run.checkpoints?.length ? (
            <button
              className="button primary"
              onClick={() => setRunAction({ mode: "resume" })}
              disabled={busy}
              title="从最近任务边界检查点继续（推荐）"
            >
              <History size={16} /><span>从检查点继续</span>
            </button>
          ) : null}
          {workspaceMode === "monitor" && run && activeRunStatuses.has(run.status) && (
            <button className="button danger-quiet" onClick={() => void cancel()} disabled={busy} title="取消运行"><Ban size={16} /><span>取消</span></button>
          )}
          {workspaceMode === "monitor" && run && retryableStatuses.has(run.status) && (
            <button
              className="button secondary"
              onClick={() => void retry()}
              disabled={busy}
              title={run.status === "interrupted" ? "放弃检查点，用同一目标新开一条 run" : "以同一目标新开一条关联 run"}
            >
              <RotateCcw size={16} />
              <span>{run.status === "interrupted" ? "重新开始" : "重试为新运行"}</span>
            </button>
          )}
          <button
            className="icon-button"
            onClick={cycleTheme}
            aria-label="切换主题"
            title={`切换主题（当前：${themeModeLabel(themeMode)}）`}
          >
            {themeMode === "light" ? <Sun size={17} /> : themeMode === "dark" ? <Moon size={17} /> : <Monitor size={17} />}
          </button>
          {workspaceMode === "monitor" && <button className="button primary" aria-label="新建运行" title="新建运行" disabled={!config} onClick={() => openLauncher()}><Plus size={16} /><span>新建运行</span></button>}
        </div>
      </header>

      <nav className="mobile-nav" aria-label="移动端视图">
        {workspaceMode === "evolution" || workspaceMode === "experience" ? <>
          <MobileTab active={false} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("graph"); setMobileView("flow"); }} icon={<Activity size={16} />} label="运行" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("design"); setMobileView("design"); }} icon={<Network size={16} />} label="编排" />
          <MobileTab active={workspaceMode === "evolution"} onClick={() => { setWorkspaceMode("evolution"); setMobileView("evolution"); }} icon={<Sparkles size={16} />} label="演进" />
          <MobileTab active={workspaceMode === "experience"} onClick={() => { setWorkspaceMode("experience"); setMobileView("experience"); }} icon={<BookMarked size={16} />} label="经验" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("settings"); setMobileView("settings"); }} icon={<Settings2 size={16} />} label="设置" />
        </> : workspaceMode === "settings" ? <>
          <MobileTab active={false} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("graph"); setMobileView("flow"); }} icon={<Activity size={16} />} label="运行" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("design"); setMobileView("design"); }} icon={<Network size={16} />} label="编排" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("evolution"); setMobileView("evolution"); }} icon={<Sparkles size={16} />} label="演进" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("experience"); setMobileView("experience"); }} icon={<BookMarked size={16} />} label="经验" />
          <MobileTab active icon={<Settings2 size={16} />} label="设置" onClick={() => { setWorkspaceMode("settings"); setMobileView("settings"); }} />
        </> : <>
          <MobileTab active={workspaceMode === "monitor" && mobileView === "runs"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("runs"); }} icon={<Rows3 size={16} />} label="运行" />
          <MobileTab active={workspaceMode === "design"} onClick={() => { setWorkspaceMode("design"); setMobileView("design"); }} icon={<Network size={16} />} label="编排" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "flow"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("graph"); setMobileView("flow"); }} icon={<Workflow size={16} />} label="任务图" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "details"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("details"); }} icon={<CircleDot size={16} />} label="详情" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "logs"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("activity"); setMobileView("logs"); }} icon={<ScrollText size={16} />} label="日志" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "evidence"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("evidence"); setMobileView("evidence"); }} icon={<FileCheck2 size={16} />} label="证据" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "usage"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("usage"); setMobileView("usage"); }} icon={<Gauge size={16} />} label="用量" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("settings"); setMobileView("settings"); }} icon={<Settings2 size={16} />} label="设置" />
        </>}
      </nav>

      <div className="workspace-shell">
        {workspaceMode === "settings" ? (
          <SettingsWorkbench />
        ) : workspaceMode === "evolution" && config && scope ? (
          <EvolutionWorkbench key={scopeKey} scope={scope} config={config} />
        ) : workspaceMode === "experience" && scope ? (
          <ExperienceWorkbench key={`experience:${scopeKey}`} scope={scope} />
        ) : workspaceMode === "design" && config ? (
          <StrategyComposer
            config={config}
            onPreflight={preflightBlueprint}
            onSave={saveBlueprint}
            onDelete={deleteBlueprint}
            onLaunch={(strategy) => openLauncher(strategy)}
          />
        ) : (
          <section className="monitor-workbench" aria-label="运行工作台">
            <RunRail
              runs={runs}
              selectedRunId={selectedRunId}
              busy={busy}
              onSelect={handleSelectRun}
              onCreate={openLauncher}
              onCleanup={openCleanup}
              onDelete={(runId) => void handleDeleteRun(runId)}
            />
            <section className="run-workspace">
              <header className="run-workspace-header">
                <div className="run-workspace-title">
                  <div>
                    <h1 title={run?.goal}>{run ? summarizeGoal(run.goal, 72) : "选择一个运行"}</h1>
                    {run && (
                      <span>
                        {strategyDisplayName(run.strategy.name)} · {completedTasks}/{run.tasks.length} 任务完成
                        {run.error ? ` · ${humanizeFailure(run.error)}` : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div className="run-view-tabs" role="tablist" aria-label="运行视图">
                  <button role="tab" aria-selected={monitorPanel === "graph"} className={monitorPanel === "graph" ? "is-active" : ""} onClick={() => setMonitorPanel("graph")}>
                    <Workflow size={16} />任务图
                  </button>
                  <button role="tab" aria-selected={monitorPanel === "activity"} className={monitorPanel === "activity" ? "is-active" : ""} onClick={() => setMonitorPanel("activity")}>
                    <ScrollText size={16} />活动日志
                  </button>
                  <button role="tab" aria-selected={monitorPanel === "evidence"} className={monitorPanel === "evidence" ? "is-active" : ""} onClick={() => setMonitorPanel("evidence")}>
                    <FileCheck2 size={16} />交付证据
                  </button>
                  <button role="tab" aria-selected={monitorPanel === "usage"} className={monitorPanel === "usage" ? "is-active" : ""} onClick={() => setMonitorPanel("usage")}>
                    <Gauge size={16} />用量
                  </button>
                </div>
              </header>
              <div className={`run-panel run-panel-graph ${monitorPanel === "graph" ? "is-active" : ""}`}>
                <DagCanvas run={run} selectedTaskId={selectedTaskId} onSelectTask={handleSelectTask} />
              </div>
              <div className={`run-panel run-panel-activity ${monitorPanel === "activity" ? "is-active" : ""}`}>
                <EventConsole run={run} events={events} connected={connected} exporting={busy} onExport={() => void exportRunEvents()} />
              </div>
              <div className={`run-panel run-panel-evidence ${monitorPanel === "evidence" ? "is-active" : ""}`}>
                <EvidenceCenter run={run} evidence={evidence} loading={evidenceLoading} onReadArtifact={readEvidenceArtifact} />
              </div>
              <div className={`run-panel run-panel-usage ${monitorPanel === "usage" ? "is-active" : ""}`}>
                <UsagePanel report={usageReport} loading={usageLoading} selectedRunId={selectedRunId} onRefresh={() => void refreshUsage().catch((requestError: unknown) => setError(runActionErrorMessage(requestError)))} />
              </div>
            </section>
            <TaskInspector run={run} task={selectedTask} />
          </section>
        )}
      </div>
      {error && !launcherOpen && <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="关闭错误">×</button></div>}
      {config && (
        <RunLauncher
          open={launcherOpen}
          config={config}
          {...(scope ? { scope } : {})}
          {...(launcherStrategy ? { initialStrategy: launcherStrategy } : {})}
          busy={busy}
          error={error}
          roleDefaults={roleDefaults}
          showCliPicker={showCliPicker}
          {...(cliInventory ? { inventory: cliInventory } : {})}
          onClose={() => { setLauncherOpen(false); setLauncherStrategy(undefined); }}
          onSubmit={create}
        />
      )}
      <RunActionDialog
        mode={runAction?.mode}
        {...(runAction?.approval ? { approval: runAction.approval } : {})}
        busy={busy}
        {...(error ? { error } : {})}
        onClose={() => setRunAction(undefined)}
        onSubmit={submitRunAction}
      />
      <RunCleanupDialog
        open={cleanupOpen}
        preview={cleanupPreview}
        busy={busy}
        error={cleanupError}
        onPreview={previewCleanup}
        onConfirm={confirmCleanup}
        onResetPreview={() => { setCleanupPreview(undefined); setCleanupError(undefined); }}
        onClose={() => { setCleanupOpen(false); setCleanupPreview(undefined); setCleanupError(undefined); }}
      />
    </div>
  );
}

function MobileTab({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return <button className={active ? "is-active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function latestPendingApproval(run: RunState | undefined): ApprovalRequest | undefined {
  for (let index = (run?.approvals?.length ?? 0) - 1; index >= 0; index -= 1) {
    const approval = run?.approvals?.[index];
    if (approval?.status === "pending") return approval;
  }
  return undefined;
}
