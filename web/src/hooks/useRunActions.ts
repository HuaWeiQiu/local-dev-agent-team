import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import {
  cancelRun,
  cleanupRuns,
  deleteRun,
  deleteStrategyBlueprint,
  downloadRunEvents,
  getEvidenceFile,
  preflightStrategyBlueprint,
  previewRunCleanup,
  respondApproval,
  resumeRun,
  retryRun,
  saveStrategyBlueprint,
  startRun,
} from "../api";
import { runActionErrorMessage, summarizeGoal } from "../presentation";
import type { MonitorPanel } from "../components/RunDashboard";
import type { RunMonitor } from "./useRunEvents";
import type {
  ApprovalRequest,
  EvidenceFilePreview,
  ProjectScope,
  RunCleanupPreview,
  StartRunInput,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
} from "../types";

interface UseRunActionsOptions {
  scope: ProjectScope | undefined;
  /** useRunEvents 返回的运行监控数据与刷新函数 */
  monitor: RunMonitor;
  setMonitorPanel: Dispatch<SetStateAction<MonitorPanel>>;
  setMobileView: Dispatch<SetStateAction<"runs" | "design" | "evolution" | "experience" | "project" | "settings" | "flow" | "details" | "logs" | "evidence" | "usage">>;
  setWorkspaceMode: Dispatch<SetStateAction<"monitor" | "design" | "evolution" | "experience" | "project" | "settings">>;
  setLauncherOpen: Dispatch<SetStateAction<boolean>>;
  setLauncherStrategy: Dispatch<SetStateAction<string | undefined>>;
}

/**
 * 运行相关 mutation 封装：create/cancel/retry/delete/resume/respondApproval、
 * 批量清理、策略蓝图保存与证据/事件导出，含 busy/error 处理现状（自 App.tsx 原样搬移）。
 */
export function useRunActions({
  scope,
  monitor,
  setMonitorPanel,
  setMobileView,
  setWorkspaceMode,
  setLauncherOpen,
  setLauncherStrategy,
}: UseRunActionsOptions) {
  const {
    runs,
    selectedRunId,
    setSelectedRunId,
    setRun,
    setEvents,
    setEvidence,
    setError,
    refreshRuns,
    refreshRun,
    refreshConfig,
  } = monitor;
  const [busy, setBusy] = useState(false);
  const [runAction, setRunAction] = useState<{
    mode: "approval" | "resume";
    approval?: ApprovalRequest;
  }>();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState<RunCleanupPreview>();
  const [cleanupError, setCleanupError] = useState<string>();

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
  }, [refreshRuns, runs, scope, selectedRunId, setRun, setEvidence, setSelectedRunId, setEvents, setError]);

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
  }, [scope, selectedRunId, setError]);

  return {
    busy,
    setBusy,
    runAction,
    setRunAction,
    cleanupOpen,
    cleanupPreview,
    cleanupError,
    setCleanupOpen,
    setCleanupPreview,
    setCleanupError,
    create,
    cancel,
    retry,
    submitRunAction,
    handleDeleteRun,
    openCleanup,
    previewCleanup,
    confirmCleanup,
    readEvidenceArtifact,
    exportRunEvents,
    preflightBlueprint,
    saveBlueprint,
    deleteBlueprint,
  };
}
