import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { EditablePlan } from "../components/PlanEditor";
import type { MonitorPanel } from "../components/RunPage";
import { runActionErrorMessage } from "../presentation";
import type {
  ApprovalRequest,
  EvidenceFilePreview,
  ProjectScope,
  RunCleanupPreview,
  StartRunInput,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
} from "../types";
import {
  cancelRunCommand,
  confirmCleanupCommand,
  createRunCommand,
  deleteBlueprintCommand,
  deleteRunCommand,
  exportEventsCommand,
  preflightBlueprintCommand,
  previewCleanupCommand,
  publishRunCommand,
  readEvidenceCommand,
  retryRunCommand,
  saveBlueprintCommand,
  submitRunActionCommand,
} from "./run-actions/commands";
import type { CommandDeps } from "./run-actions/commands";
import type { RunMonitor } from "./useRunEvents";

interface UseRunActionsOptions {
  scope: ProjectScope | undefined;
  /** useRunEvents 返回的运行监控数据与刷新函数 */
  monitor: RunMonitor;
  setMonitorPanel: Dispatch<SetStateAction<MonitorPanel>>;
  setMonitorView: Dispatch<SetStateAction<"board" | "run">>;
  setWorkspaceMode: Dispatch<
    SetStateAction<"monitor" | "design" | "evolution" | "experience" | "project" | "settings">
  >;
  setLauncherOpen: Dispatch<SetStateAction<boolean>>;
  setLauncherStrategy: Dispatch<SetStateAction<string | undefined>>;
}

/**
 * 运行相关 mutation 的动作表：每条命令在 `run-actions/commands.ts`，
 * 这里只维护 busy/error 通道和本地弹窗状态。
 */
export function useRunActions(options: UseRunActionsOptions) {
  const { scope, monitor, setMonitorPanel, setMonitorView, setWorkspaceMode } = options;
  const { setLauncherOpen, setLauncherStrategy } = options;
  const [busy, setBusy] = useState(false);
  const [runAction, setRunAction] = useState<{
    mode: "approval" | "resume" | "pause";
    approval?: ApprovalRequest;
  }>();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState<RunCleanupPreview>();
  const [cleanupError, setCleanupError] = useState<string>();

  /** One command at a time, with the shared error channel (or a dialog-local one). */
  const run = useCallback(
    async (operation: () => Promise<void>, onError?: (message: string) => void): Promise<void> => {
      setBusy(true);
      monitor.setError(undefined);
      try {
        await operation();
      } catch (requestError) {
        (onError ?? monitor.setError)(runActionErrorMessage(requestError));
      } finally {
        setBusy(false);
      }
    },
    [monitor],
  );

  const deps: CommandDeps = {
    scope,
    monitor,
    setMonitorPanel,
    setMonitorView,
    setWorkspaceMode,
    setLauncherOpen,
    setLauncherStrategy,
    setBusy,
    setError: monitor.setError,
    setCleanupOpen,
    setCleanupPreview,
    setCleanupError,
    cleanupPreview,
    setRunAction: () => setRunAction(undefined),
    run,
  };

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
    create: (input: StartRunInput): Promise<boolean> => createRunCommand(deps, input),
    cancel: (): Promise<void> => cancelRunCommand(deps),
    retry: (): Promise<void> => retryRunCommand(deps),
    publish: (): Promise<void> => publishRunCommand(deps),
    preflightBlueprint: (
      name: string,
      definition: StrategyBlueprintDefinition,
    ): Promise<StrategyBlueprintResult> => preflightBlueprintCommand(deps, name, definition),
    saveBlueprint: (
      name: string,
      definition: StrategyBlueprintDefinition,
    ): Promise<StrategyBlueprintResult> => saveBlueprintCommand(deps, name, definition),
    deleteBlueprint: (name: string): Promise<void> => deleteBlueprintCommand(deps, name),
    openCleanup: (): void => {
      setCleanupPreview(undefined);
      setCleanupError(undefined);
      setCleanupOpen(true);
    },
    handleDeleteRun: (runId: string): Promise<void> => deleteRunCommand(deps, runId),
    submitRunAction: (input: {
      decision?: "approved" | "rejected";
      actor: string;
      reason: string;
      plan?: EditablePlan;
    }): Promise<void> =>
      submitRunActionCommand(deps, runAction?.mode ?? "resume", runAction?.approval?.id, input),
    previewCleanup: (days: number): Promise<void> => previewCleanupCommand(deps, days),
    confirmCleanup: (): Promise<void> => confirmCleanupCommand(deps),
    readEvidenceArtifact: (path: string): Promise<EvidenceFilePreview> =>
      readEvidenceCommand(deps, path),
    exportRunEvents: (): Promise<void> => exportEventsCommand(deps),
  };
}
