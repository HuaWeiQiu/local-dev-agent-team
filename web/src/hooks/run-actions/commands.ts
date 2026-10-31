import {
  cancelRun,
  cleanupRuns,
  deleteRun,
  deleteStrategyBlueprint,
  downloadRunEvents,
  getEvidenceFile,
  pauseRun,
  preflightStrategyBlueprint,
  previewRunCleanup,
  publishRun,
  respondApproval,
  resumeRun,
  retryRun,
  saveStrategyBlueprint,
  startRun,
} from "../../api";
import { summarizeGoal } from "../../presentation";
import type { EditablePlan } from "../../components/PlanEditor";
import type { MonitorPanel } from "../../components/RunPage";
import type { RunMonitor } from "../useRunEvents";
import type {
  EvidenceFilePreview,
  ProjectScope,
  RunCleanupPreview,
  StartRunInput,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
} from "../../types";

export interface CommandDeps {
  scope: ProjectScope | undefined;
  monitor: RunMonitor;
  setMonitorPanel(value: MonitorPanel): void;
  setMonitorView(value: "board" | "run"): void;
  setWorkspaceMode(value: "monitor" | "design" | "evolution" | "experience" | "project" | "settings"): void;
  setLauncherOpen(value: boolean): void;
  setLauncherStrategy(value: string | undefined): void;
  setBusy(value: boolean): void;
  setError(value: string | undefined): void;
  setCleanupOpen(value: boolean): void;
  setCleanupPreview(value: RunCleanupPreview | undefined): void;
  cleanupPreview: RunCleanupPreview | undefined;
  setCleanupError(value: string | undefined): void;
  setRunAction(value: undefined): void;
  /** Run one command with the busy flag and the shared error channel. */
  run(
    operation: () => Promise<void>,
    onError?: (message: string) => void,
  ): Promise<void>;
}

/** Start a run; the launcher stays open (and the goal keeps its text) on failure. */
export async function createRunCommand(deps: CommandDeps, input: StartRunInput): Promise<boolean> {
  if (!deps.scope) return false;
  let started = false;
  await deps.run(
    async () => {
      const runId = await startRun(deps.scope!, input);
      deps.setLauncherOpen(false);
      deps.setLauncherStrategy(undefined);
      deps.monitor.setSelectedRunId(runId);
      deps.setMonitorPanel("activity");
      deps.setMonitorView("run");
      deps.setWorkspaceMode("monitor");
      await deps.monitor.refreshRuns();
      started = true;
    },
  );
  return started;
}

export async function preflightBlueprintCommand(
  deps: CommandDeps,
  name: string,
  definition: StrategyBlueprintDefinition,
): Promise<StrategyBlueprintResult> {
  const scope = requireScope(deps);
  return await preflightStrategyBlueprint(scope, name, definition);
}

export async function saveBlueprintCommand(
  deps: CommandDeps,
  name: string,
  definition: StrategyBlueprintDefinition,
): Promise<StrategyBlueprintResult> {
  const scope = requireScope(deps);
  const result = await saveStrategyBlueprint(scope, name, definition);
  await deps.monitor.refreshConfig();
  return result;
}

export async function deleteBlueprintCommand(deps: CommandDeps, name: string): Promise<void> {
  const scope = requireScope(deps);
  await deleteStrategyBlueprint(scope, name);
  await deps.monitor.refreshConfig();
}

export async function deleteRunCommand(deps: CommandDeps, runId: string): Promise<void> {
  if (!deps.scope) return;
  if (!confirmDelete(deps, runId)) return;
  await deps.run(async () => {
    await deleteRun(deps.scope!, runId);
    if (deps.monitor.selectedRunId === runId) deps.monitor.setSelectedRunId(undefined);
    await deps.monitor.refreshRuns();
  });
}

function confirmDelete(deps: CommandDeps, runId: string): boolean {
  const target = deps.monitor.runs.find((item) => item.id === runId);
  const label = target ? summarizeGoal(target.goal, 40) : runId;
  return window.confirm(`确定删除运行「${label}」？本地记录与证据将永久删除。`);
}

export async function cancelRunCommand(deps: CommandDeps): Promise<void> {
  const runId = deps.monitor.selectedRunId;
  if (!deps.scope || !runId) return;
  await deps.run(() => cancelRun(deps.scope!, runId));
}

export async function retryRunCommand(deps: CommandDeps): Promise<void> {
  const runId = deps.monitor.selectedRunId;
  if (!deps.scope || !runId) return;
  await deps.run(async () => {
    const nextId = await retryRun(deps.scope!, runId);
    deps.monitor.setSelectedRunId(nextId);
    deps.setMonitorPanel("activity");
    deps.setMonitorView("run");
    await deps.monitor.refreshRuns();
  });
}

export async function publishRunCommand(deps: CommandDeps): Promise<void> {
  const runId = deps.monitor.selectedRunId;
  if (!deps.scope || !runId) return;
  await deps.run(async () => {
    const result = await publishRun(deps.scope!, runId);
    await Promise.all([deps.monitor.refreshRuns(), deps.monitor.refreshRun(runId)]);
    if (result.pullRequestUrl) window.open(result.pullRequestUrl, "_blank", "noopener");
  });
}

export async function submitRunActionCommand(
  deps: CommandDeps,
  mode: "approval" | "resume" | "pause",
  approvalId: string | undefined,
  input: { decision?: "approved" | "rejected"; actor: string; reason: string; plan?: EditablePlan },
): Promise<void> {
  const runId = deps.monitor.selectedRunId;
  if (!deps.scope || !runId) return;
  await deps.run(async () => {
    await dispatchAction(deps.scope!, runId, mode, approvalId, input);
    deps.setRunAction(undefined);
    await Promise.all([deps.monitor.refreshRuns(), deps.monitor.refreshRun(runId)]);
  });
}

async function dispatchAction(
  scope: ProjectScope,
  runId: string,
  mode: "approval" | "resume" | "pause",
  approvalId: string | undefined,
  input: { decision?: "approved" | "rejected"; actor: string; reason: string; plan?: EditablePlan },
): Promise<void> {
  if (mode === "approval") {
    if (!approvalId || !input.decision) return;
    await respondApproval(scope, runId, {
      requestId: approvalId,
      decision: input.decision,
      actor: input.actor,
      reason: input.reason,
      ...(input.plan ? { plan: input.plan } : {}),
    });
    return;
  }
  if (mode === "pause") {
    await pauseRun(scope, runId, { actor: input.actor, reason: input.reason });
    return;
  }
  await resumeRun(scope, runId, { actor: input.actor, reason: input.reason });
}

export async function previewCleanupCommand(deps: CommandDeps, days: number): Promise<void> {
  if (!deps.scope) return;
  await deps.run(
    async () => {
      deps.setCleanupPreview(await previewRunCleanup(deps.scope!, days));
    },
    (message) => deps.setCleanupError(message),
  );
}

export async function confirmCleanupCommand(deps: CommandDeps): Promise<void> {
  const preview = deps.cleanupPreview;
  if (!deps.scope || !preview) return;
  await deps.run(
    async () => {
      await cleanupRuns(deps.scope!, preview.token);
      deps.setCleanupOpen(false);
      deps.setCleanupPreview(undefined);
      deps.monitor.setRun(undefined);
      await deps.monitor.refreshRuns();
    },
    (message) => deps.setCleanupError(message),
  );
}

export async function readEvidenceCommand(
  deps: CommandDeps,
  artifactPath: string,
): Promise<EvidenceFilePreview> {
  const runId = deps.monitor.selectedRunId;
  if (!deps.scope || !runId) throw new Error("当前运行尚未加载");
  return await getEvidenceFile(deps.scope, runId, artifactPath);
}

export async function exportEventsCommand(deps: CommandDeps): Promise<void> {
  const runId = deps.monitor.selectedRunId;
  if (!deps.scope || !runId) return;
  await deps.run(() => downloadRunEvents(deps.scope!, runId));
}

function requireScope(deps: CommandDeps): ProjectScope {
  if (!deps.scope) throw new Error("当前项目尚未加载");
  return deps.scope;
}
