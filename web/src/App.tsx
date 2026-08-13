import { isTauri } from "@tauri-apps/api/core";
import { Activity, Ban, BookMarked, Bot, CircleDot, FileCheck2, FolderCog, FolderPlus, Gauge, GitBranch, GitPullRequest, History, Monitor, Moon, Network, Pause, Plus, Radio, RotateCcw, Rows3, ScrollText, Settings2, ShieldCheck, Sparkles, Sun, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getWorkspace } from "./api";
import { EvolutionWorkbench } from "./components/EvolutionWorkbench";
import { ExperienceWorkbench } from "./components/ExperienceWorkbench";
import { RunCleanupDialog } from "./components/RunCleanupDialog";
import { RunDashboard, type MonitorPanel } from "./components/RunDashboard";
import { RunLauncher } from "./components/RunLauncher";
import { RunActionDialog } from "./components/RunActionDialog";
import { SettingsWorkbench } from "./components/SettingsWorkbench";
import { StrategyComposer } from "./components/StrategyComposer";
import { RunStatusBadge } from "./components/StatusBadge";
import { useDesktopProject } from "./hooks/useDesktopProject";
import { useDesktopSettings } from "./hooks/useDesktopSettings";
import { useRunActions } from "./hooks/useRunActions";
import { latestPendingApproval, useRunEvents } from "./hooks/useRunEvents";
import { useThemeMode } from "./hooks/useThemeMode";
import { activeRunStatuses, preferredMonitorPanel, runActionErrorMessage } from "./presentation";
import { themeModeLabel } from "./theme";
import type { ProjectScope, TaskRunState, WorkspaceInfo } from "./types";

const retryableStatuses = new Set(["blocked", "cancelled", "interrupted"]);

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [launcherStrategy, setLauncherStrategy] = useState<string>();
  const [workspaceMode, setWorkspaceMode] = useState<"monitor" | "design" | "evolution" | "experience" | "project" | "settings">("monitor");
  const [monitorPanel, setMonitorPanel] = useState<MonitorPanel>("graph");
  const [mobileView, setMobileView] = useState<"runs" | "design" | "evolution" | "experience" | "project" | "settings" | "flow" | "details" | "logs" | "evidence" | "usage">("flow");
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
    evidenceVisible: monitorPanel === "evidence" || mobileView === "evidence",
    usageVisible: monitorPanel === "usage" || mobileView === "usage",
  });
  const { config, runs, run, connected, error, setError, setSelectedRunId, setSelectedTaskId } = monitor;
  // 运行 mutation（create/cancel/retry/delete/审批/继续/清理/蓝图）与 busy 状态
  const actions = useRunActions({
    scope,
    monitor,
    setMonitorPanel,
    setMobileView,
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

  const openLauncher = useCallback((strategy?: string) => {
    setError(undefined);
    setLauncherStrategy(strategy);
    setLauncherOpen(true);
    void refreshDesktopSettings();
  }, [refreshDesktopSettings, setError]);

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
  }, [runs, setSelectedRunId]);

  const handleSelectTask = useCallback((task: TaskRunState) => {
    setSelectedTaskId(task.task.id);
    if (window.innerWidth <= 800) setMobileView("details");
  }, [setSelectedTaskId]);

  const pendingApproval = latestPendingApproval(run);

  if (!workspace || !selectedProjectId) {
    return <div className="boot-screen"><CircleDot className="boot-mark" size={28} /><strong>Agent Team</strong><span>{error ?? "连接控制服务"}</span></div>;
  }

  const selectedProject = workspace.projects.find((project) => project.id === selectedProjectId);

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
            className={workspaceMode === "project" ? "is-active" : ""}
            onClick={() => { setWorkspaceMode("project"); setMobileView("project"); }}
            aria-label="项目设置"
            title="项目设置 · 当前项目角色覆盖"
            disabled={!scope}
          >
            <FolderCog size={20} /><span>项目</span>
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
                actions.setRunAction(undefined);
                actions.setCleanupOpen(false);
                actions.setCleanupPreview(undefined);
                actions.setCleanupError(undefined);
                monitor.resetRunScope();
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
          {workspaceMode === "design" ? <><span className="topbar-context-label">策略工作室</span><strong>拓扑与执行政策</strong></> : workspaceMode === "evolution" ? <><span className="topbar-context-label">演进工作台</span><strong>候选、预检与人工门禁</strong></> : workspaceMode === "experience" ? <><span className="topbar-context-label">经验库</span><strong>候选晋升与跨项目共享</strong></> : workspaceMode === "project" ? <><span className="topbar-context-label">项目设置</span><strong>当前项目角色覆盖</strong></> : workspaceMode === "settings" ? <><span className="topbar-context-label">全局设置</span><strong>本机 CLI 与角色默认</strong></> : run ? (
            <>
              <RunStatusBadge status={run.status} />
              <strong>{run.goal}</strong>
              {run.pullRequestUrl && (
                <a
                  className="pr-link"
                  href={run.pullRequestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="查看 Pull Request"
                >
                  <GitPullRequest size={13} />
                  PR #{run.pullRequestNumber ?? ""}
                </a>
              )}
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
              onClick={() => actions.setRunAction({ mode: "approval", approval: pendingApproval })}
              disabled={busy}
              title="处理审批"
            >
              <ShieldCheck size={16} /><span>处理审批</span>
            </button>
          )}
          {workspaceMode === "monitor" && run?.status === "interrupted" && run.checkpoints?.length ? (
            <button
              className="button primary"
              onClick={() => actions.setRunAction({ mode: "resume" })}
              disabled={busy}
              title="从最近任务边界检查点继续（推荐）"
            >
              <History size={16} /><span>从检查点继续</span>
            </button>
          ) : null}
          {workspaceMode === "monitor" && run && ["ready-to-merge", "ci-failed"].includes(run.status) && (
            <button
              className="button primary"
              onClick={() => void actions.publish()}
              disabled={busy}
              title="推送集成分支并创建 Pull Request"
            >
              <GitPullRequest size={16} /><span>发布</span>
            </button>
          )}
          {workspaceMode === "monitor" && run && activeRunStatuses.has(run.status) && (
            <button
              className="button secondary"
              onClick={() => actions.setRunAction({ mode: "pause" })}
              disabled={busy}
              title="暂停运行（保留检查点，稍后可恢复）"
            >
              <Pause size={16} /><span>暂停</span>
            </button>
          )}
          {workspaceMode === "monitor" && run && activeRunStatuses.has(run.status) && (
            <button className="button danger-quiet" onClick={() => void actions.cancel()} disabled={busy} title="取消运行"><Ban size={16} /><span>取消</span></button>
          )}
          {workspaceMode === "monitor" && run && retryableStatuses.has(run.status) && (
            <button
              className="button secondary"
              onClick={() => void actions.retry()}
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
        {workspaceMode === "evolution" || workspaceMode === "experience" || workspaceMode === "project" ? <>
          <MobileTab active={false} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("graph"); setMobileView("flow"); }} icon={<Activity size={16} />} label="运行" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("design"); setMobileView("design"); }} icon={<Network size={16} />} label="编排" />
          <MobileTab active={workspaceMode === "evolution"} onClick={() => { setWorkspaceMode("evolution"); setMobileView("evolution"); }} icon={<Sparkles size={16} />} label="演进" />
          <MobileTab active={workspaceMode === "experience"} onClick={() => { setWorkspaceMode("experience"); setMobileView("experience"); }} icon={<BookMarked size={16} />} label="经验" />
          <MobileTab active={workspaceMode === "project"} onClick={() => { setWorkspaceMode("project"); setMobileView("project"); }} icon={<FolderCog size={16} />} label="项目" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("settings"); setMobileView("settings"); }} icon={<Settings2 size={16} />} label="设置" />
        </> : workspaceMode === "settings" ? <>
          <MobileTab active={false} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("graph"); setMobileView("flow"); }} icon={<Activity size={16} />} label="运行" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("design"); setMobileView("design"); }} icon={<Network size={16} />} label="编排" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("evolution"); setMobileView("evolution"); }} icon={<Sparkles size={16} />} label="演进" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("experience"); setMobileView("experience"); }} icon={<BookMarked size={16} />} label="经验" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("project"); setMobileView("project"); }} icon={<FolderCog size={16} />} label="项目" />
          <MobileTab active icon={<Settings2 size={16} />} label="设置" onClick={() => { setWorkspaceMode("settings"); setMobileView("settings"); }} />
        </> : <>
          <MobileTab active={workspaceMode === "monitor" && mobileView === "runs"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("runs"); }} icon={<Rows3 size={16} />} label="运行" />
          <MobileTab active={workspaceMode === "design"} onClick={() => { setWorkspaceMode("design"); setMobileView("design"); }} icon={<Network size={16} />} label="编排" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "flow"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("graph"); setMobileView("flow"); }} icon={<Workflow size={16} />} label="任务图" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "details"} onClick={() => { setWorkspaceMode("monitor"); setMobileView("details"); }} icon={<CircleDot size={16} />} label="详情" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "logs"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("activity"); setMobileView("logs"); }} icon={<ScrollText size={16} />} label="日志" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "evidence"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("evidence"); setMobileView("evidence"); }} icon={<FileCheck2 size={16} />} label="证据" />
          <MobileTab active={workspaceMode === "monitor" && mobileView === "usage"} onClick={() => { setWorkspaceMode("monitor"); setMonitorPanel("usage"); setMobileView("usage"); }} icon={<Gauge size={16} />} label="用量" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("project"); setMobileView("project"); }} icon={<FolderCog size={16} />} label="项目" />
          <MobileTab active={false} onClick={() => { setWorkspaceMode("settings"); setMobileView("settings"); }} icon={<Settings2 size={16} />} label="设置" />
        </>}
      </nav>

      <div className="workspace-shell">
        {workspaceMode === "settings" ? (
          <SettingsWorkbench
            pane="global"
            {...(scope ? { scope } : {})}
            {...(selectedProject?.name ? { projectName: selectedProject.name } : {})}
            onOpenProject={() => { setWorkspaceMode("project"); setMobileView("project"); }}
            onSaved={() => void refreshDesktopSettings()}
          />
        ) : workspaceMode === "project" && scope ? (
          <SettingsWorkbench
            pane="project"
            scope={scope}
            {...(selectedProject?.name ? { projectName: selectedProject.name } : {})}
            onOpenGlobal={() => { setWorkspaceMode("settings"); setMobileView("settings"); }}
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
        ) : (
          <RunDashboard
            monitor={monitor}
            busy={busy}
            monitorPanel={monitorPanel}
            onMonitorPanelChange={setMonitorPanel}
            onSelectRun={handleSelectRun}
            onCreate={openLauncher}
            onCleanup={actions.openCleanup}
            onDeleteRun={actions.handleDeleteRun}
            onSelectTask={handleSelectTask}
            onExportEvents={actions.exportRunEvents}
            onReadArtifact={actions.readEvidenceArtifact}
            onRefreshUsage={() => void monitor.refreshUsage().catch((requestError: unknown) => setError(runActionErrorMessage(requestError)))}
          />
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
    </div>
  );
}

function MobileTab({ active, onClick, icon, label }: { active: boolean; onClick(): void; icon: React.ReactNode; label: string }) {
  return <button className={active ? "is-active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}
