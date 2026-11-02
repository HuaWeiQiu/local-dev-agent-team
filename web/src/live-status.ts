import type { AgentInvocationActivity } from "./agent-activity";
import { activeRunStatuses, agentRoleLabel, runStatusLabel } from "./presentation";
import type { RunState } from "./types";

export interface LiveWorker {
  id: string;
  label: string;
  advisor: boolean;
}

export interface LiveStatus {
  statusLabel: string;
  /** True while the run is executing an automated stage. */
  running: boolean;
  startedAt: string;
  workers: LiveWorker[];
  hiddenWorkers: number;
  tasksDone: number;
  tasksTotal: number;
  pendingApprovals: number;
  invocations: { used: number; max: number };
  advisor: { used: number; max: number } | undefined;
}

const MAX_VISIBLE_WORKERS = 3;

function activeInvocations(
  run: RunState,
  invocations: AgentInvocationActivity[],
): AgentInvocationActivity[] {
  if (!activeRunStatuses.has(run.status)) return [];
  return invocations.filter((invocation) => invocation.status === "running");
}

function toWorker(invocation: AgentInvocationActivity): LiveWorker {
  return {
    id: invocation.id,
    label: `${agentRoleLabel(invocation.role)} · ${invocation.profile}`,
    advisor: invocation.advisor === true,
  };
}

function taskProgress(tasks: RunState["tasks"]): { done: number; total: number } {
  return {
    done: tasks.filter((task) => task.status === "passed" || task.status === "merged").length,
    total: tasks.length,
  };
}

function advisorBudget(run: RunState): LiveStatus["advisor"] {
  const advisor = run.strategy.advisor;
  if (!advisor?.enabled) return undefined;
  return { used: run.advisorConsultations ?? 0, max: advisor.maxConsultationsPerRun };
}

function pendingApprovals(run: RunState): number {
  return (run.approvals ?? []).filter((approval) => approval.status === "pending").length;
}

export function deriveLiveStatus(
  run: RunState | undefined,
  invocations: AgentInvocationActivity[],
): LiveStatus | undefined {
  if (!run) return undefined;
  const active = activeInvocations(run, invocations);
  const visible = active.slice(0, MAX_VISIBLE_WORKERS);
  const tasks = taskProgress(run.tasks);
  return {
    statusLabel: runStatusLabel(run.status),
    running: activeRunStatuses.has(run.status),
    startedAt: run.createdAt,
    workers: visible.map(toWorker),
    hiddenWorkers: active.length - visible.length,
    tasksDone: tasks.done,
    tasksTotal: tasks.total,
    pendingApprovals: pendingApprovals(run),
    invocations: { used: run.usage?.agentInvocations ?? 0, max: run.strategy.maxAgentInvocations },
    advisor: advisorBudget(run),
  };
}

export function formatElapsed(fromIso: string, nowMs: number): string {
  const elapsed = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(elapsed)) return "—";
  const seconds = Math.max(Math.floor(elapsed / 1000), 0);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
