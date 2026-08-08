import { Ban, CircleDot, History, Network, Plus, RotateCcw, Rows3, ScrollText, ShieldCheck, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelRun,
  deleteStrategyBlueprint,
  eventStreamUrl,
  getConfig,
  getRun,
  getRuns,
  getWorkspace,
  preflightStrategyBlueprint,
  respondApproval,
  resumeRun,
  retryRun,
  saveStrategyBlueprint,
  startRun,
} from "./api";
import { DagCanvas } from "./components/DagCanvas";
import { EventConsole } from "./components/EventConsole";
import { RunLauncher } from "./components/RunLauncher";
import { RunActionDialog } from "./components/RunActionDialog";
import { RunRail } from "./components/RunRail";
import { StrategyComposer } from "./components/StrategyComposer";
import { RunStatusBadge } from "./components/StatusBadge";
import { TaskInspector } from "./components/TaskInspector";
import type {
  ProjectScope,
  ApprovalRequest,
  PublicConfig,
  RunEvent,
  RunState,
  RunSummary,
  StartRunInput,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
  TaskRunState,
  WorkspaceInfo,
} from "./types";

const activeStatuses = new Set(["created", "orchestrating", "architecting", "planned", "implementing", "reviewing-testing", "reworking", "integrating", "final-checks", "publishing", "waiting-ci", "repairing"]);
const retryableStatuses = new Set(["blocked", "cancelled", "interrupted"]);

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [config, setConfig] = useState<PublicConfig>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [run, setRun] = useState<RunState>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherStrategy, setLauncherStrategy] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [runAction, setRunAction] = useState<{
    mode: "approval" | "resume";
    approval?: ApprovalRequest;
  }>();
  const [error, setError] = useState<string>();
  const [workspaceMode, setWorkspaceMode] = useState<"monitor" | "design">("monitor");
  const [mobileView, setMobileView] = useState<"runs" | "design" | "flow" | "details" | "logs">("flow");
  const refreshTimer = useRef<number | undefined>(undefined);
  const scope = useMemo<ProjectScope | undefined>(
    () => workspace && selectedProjectId
      ? { mode: workspace.mode, projectId: selectedProjectId }
      : undefined,
    [selectedProjectId, workspace],
  );
  const scopeKey = scope ? `${scope.mode}:${scope.projectId}` : undefined;
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;

  const refreshRuns = useCallback(async () => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    try {
      const nextRuns = await getRuns(scope);
      if (currentScopeKey.current !== requestedScope) return;
      setRuns(nextRuns);
      setSelectedRunId((current) => current ?? nextRuns[0]?.id);
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
    try {
      const nextRun = await getRun(scope, runId);
      if (currentScopeKey.current !== requestedScope) return;
      setRun(nextRun);
      setSelectedTaskId((current) => current && nextRun.tasks.some((task) => task.task.id === current) ? current : undefined);
    } catch (requestError) {
      if (currentScopeKey.current !== requestedScope) return;
      if (!(requestError instanceof ApiError && requestError.status === 404)) {
        throw requestError;
      }
    }
  }, [scope]);

  const scheduleRefresh = useCallback((runId: string) => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      void Promise.all([refreshRuns(), refreshRun(runId)]).catch((requestError: unknown) => {
        setError(errorMessage(requestError));
      });
    }, 80);
  }, [refreshRun, refreshRuns]);

  useEffect(() => {
    void getWorkspace()
      .then((nextWorkspace) => {
        setWorkspace(nextWorkspace);
        setSelectedProjectId(nextWorkspace.defaultProjectId);
      })
      .catch((requestError: unknown) => setError(errorMessage(requestError)));
    return () => window.clearTimeout(refreshTimer.current);
  }, []);

  useEffect(() => {
    if (!scope) return;
    let active = true;
    window.clearTimeout(refreshTimer.current);
    setConfig(undefined);
    setRuns([]);
    setSelectedRunId(undefined);
    setRun(undefined);
    setSelectedTaskId(undefined);
    setEvents([]);
    setConnected(false);
    setError(undefined);
    void Promise.all([getConfig(scope), getRuns(scope)])
      .then(([nextConfig, nextRuns]) => {
        if (!active) return;
        setConfig(nextConfig);
        setRuns(nextRuns);
        setSelectedRunId(nextRuns[0]?.id);
      })
      .catch((requestError: unknown) => {
        if (active) setError(errorMessage(requestError));
      });
    return () => {
      active = false;
    };
  }, [scope]);

  useEffect(() => {
    if (!scope || !selectedRunId) {
      setRun(undefined);
      setEvents([]);
      return;
    }
    setRun(undefined);
    setSelectedTaskId(undefined);
    setEvents([]);
    void refreshRun(selectedRunId).catch((requestError: unknown) => setError(errorMessage(requestError)));

    const source = new EventSource(eventStreamUrl(scope, selectedRunId));
    let active = true;
    source.onopen = () => {
      if (active) setConnected(true);
    };
    source.onerror = () => {
      if (active) setConnected(false);
    };
    source.onmessage = (message) => {
      if (!active) return;
      try {
        const event = JSON.parse(message.data) as RunEvent;
        setEvents((current) => [...current, event].slice(-500));
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
    };
  }, [refreshRun, scheduleRefresh, scope, selectedRunId]);

  const selectedTask = useMemo(
    () => run?.tasks.find((task) => task.task.id === selectedTaskId),
    [run?.tasks, selectedTaskId],
  );
  const pendingApproval = latestPendingApproval(run);

  const create = async (input: StartRunInput) => {
    if (!scope) return;
    setBusy(true);
    setError(undefined);
    try {
      const runId = await startRun(scope, input);
      setLauncherOpen(false);
      setLauncherStrategy(undefined);
      setSelectedRunId(runId);
      setMobileView("flow");
      await refreshRuns();
    } catch (requestError) {
      setError(errorMessage(requestError));
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

  const openLauncher = (strategy?: string) => {
    setError(undefined);
    setLauncherStrategy(strategy);
    setLauncherOpen(true);
  };

  const cancel = async () => {
    if (!scope || !selectedRunId) return;
    setBusy(true);
    setError(undefined);
    try {
      await cancelRun(scope, selectedRunId);
    } catch (requestError) {
      setError(errorMessage(requestError));
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
      await refreshRuns();
    } catch (requestError) {
      setError(errorMessage(requestError));
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
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  if (!workspace || !selectedProjectId) {
    return <div className="boot-screen"><CircleDot className="boot-mark" size={28} /><strong>Agent Team</strong><span>{error ?? "连接控制服务"}</span></div>;
  }

  const selectedProject = workspace.projects.find((project) => project.id === selectedProjectId);

  return (
    <div className="app-shell" data-mobile-view={mobileView}>
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark"><CircleDot size={20} /></span>
          <div className="brand-copy">
            <strong>Agent Team</strong>
            <div className="project-context">
              {workspace.projects.length > 1 ? (
                <select
                  aria-label="当前项目"
                  value={selectedProjectId}
                  disabled={busy}
                  onChange={(event) => {
                    setLauncherOpen(false);
                    setLauncherStrategy(undefined);
                    setRunAction(undefined);
                    setConfig(undefined);
                    setRuns([]);
                    setSelectedRunId(undefined);
                    setRun(undefined);
                    setSelectedTaskId(undefined);
                    setEvents([]);
                    setSelectedProjectId(event.target.value);
                    setWorkspaceMode("monitor");
                    setMobileView("flow");
                  }}
                >
                  {workspace.projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              ) : (
                <span className="project-name">{selectedProject?.name}</span>
              )}
              <span className="project-branch">{selectedProject?.defaultBranch}</span>
            </div>
          </div>
        </div>
        <div className="topbar-run">
          <div className="workspace-mode-switch" role="group" aria-label="工作台模式">
            <button className={workspaceMode === "monitor" ? "is-selected" : ""} onClick={() => setWorkspaceMode("monitor")}><Rows3 size={14} />运行</button>
            <button className={workspaceMode === "design" ? "is-selected" : ""} disabled={!config} onClick={() => setWorkspaceMode("design")}><Network size={14} />编排</button>
          </div>
          {workspaceMode === "design" ? <strong>策略拓扑与执行政策</strong> : run ? (
            <>
              <span className="topbar-context-label">当前运行</span>
              <RunStatusBadge status={run.status} />
              <strong>{run.goal}</strong>
            </>
          ) : <span>本地 Agent 控制台</span>}
        </div>
        <div className="topbar-actions">
          {pendingApproval && (
            <button
              className="button secondary"
              onClick={() => setRunAction({ mode: "approval", approval: pendingApproval })}
              disabled={busy}
              title="处理审批"
            >
              <ShieldCheck size={16} /><span>处理审批</span>
            </button>
          )}
          {run?.status === "interrupted" && run.checkpoints?.length ? (
            <button
              className="button secondary"
              onClick={() => setRunAction({ mode: "resume" })}
              disabled={busy}
              title="从检查点恢复"
            >
              <History size={16} /><span>恢复</span>
            </button>
          ) : null}
          {run && activeStatuses.has(run.status) && (
            <button className="button danger-quiet" onClick={() => void cancel()} disabled={busy} title="取消运行"><Ban size={16} /><span>取消</span></button>
          )}
          {run && retryableStatuses.has(run.status) && (
            <button className="button secondary" onClick={() => void retry()} disabled={busy} title="重试为新运行"><RotateCcw size={16} /><span>重试</span></button>
          )}
          <button className="button primary" aria-label="新建运行" title="新建运行" disabled={!config} onClick={() => openLauncher()}><Plus size={16} /><span>新建运行</span></button>
        </div>
      </header>

      <nav className="mobile-nav" aria-label="移动端视图">
        <MobileTab active={workspaceMode === "monitor" && mobileView === "runs"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("runs"); }} icon={<Rows3 size={16} />} label="运行" />
        <MobileTab active={workspaceMode === "design"} onClick={() => { setWorkspaceMode("design"); setMobileView("design"); }} icon={<Network size={16} />} label="编排" />
        <MobileTab active={workspaceMode === "monitor" && mobileView === "flow"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("flow"); }} icon={<Workflow size={16} />} label="任务图" />
        <MobileTab active={workspaceMode === "monitor" && mobileView === "details"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("details"); }} icon={<CircleDot size={16} />} label="详情" />
        <MobileTab active={workspaceMode === "monitor" && mobileView === "logs"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("logs"); }} icon={<ScrollText size={16} />} label="日志" />
      </nav>

      {workspaceMode === "design" && config ? (
        <StrategyComposer
          config={config}
          onPreflight={preflightBlueprint}
          onSave={saveBlueprint}
          onDelete={deleteBlueprint}
          onLaunch={(strategy) => openLauncher(strategy)}
        />
      ) : (
        <>
          <RunRail runs={runs} selectedRunId={selectedRunId} onSelect={(runId) => { setSelectedRunId(runId); setMobileView("flow"); }} onCreate={() => openLauncher()} />
          <DagCanvas run={run} selectedTaskId={selectedTaskId} onSelectTask={(task: TaskRunState) => { setSelectedTaskId(task.task.id); if (window.innerWidth <= 800) setMobileView("details"); }} />
          <TaskInspector run={run} task={selectedTask} />
          <EventConsole run={run} events={events} connected={connected} />
        </>
      )}
      {error && !launcherOpen && <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError(undefined)} aria-label="关闭错误">×</button></div>}
      {config && <RunLauncher open={launcherOpen} config={config} {...(launcherStrategy ? { initialStrategy: launcherStrategy } : {})} busy={busy} error={error} onClose={() => { setLauncherOpen(false); setLauncherStrategy(undefined); }} onSubmit={create} />}
      <RunActionDialog
        mode={runAction?.mode}
        {...(runAction?.approval ? { approval: runAction.approval } : {})}
        busy={busy}
        {...(error ? { error } : {})}
        onClose={() => setRunAction(undefined)}
        onSubmit={submitRunAction}
      />
    </div>
  );
}

function MobileTab({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return <button className={active ? "is-active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestPendingApproval(run: RunState | undefined): ApprovalRequest | undefined {
  for (let index = (run?.approvals?.length ?? 0) - 1; index >= 0; index -= 1) {
    const approval = run?.approvals?.[index];
    if (approval?.status === "pending") return approval;
  }
  return undefined;
}
