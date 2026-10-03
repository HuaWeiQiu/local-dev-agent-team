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

export function deriveLiveStatus(
  run: RunState | undefined,
  invocations: AgentInvocationActivity[],
): LiveStatus | undefined {
  if (!run) return undefined;
  const running = activeRunStatuses.has(run.status);
  const active = running ? invocations.filter((invocation) => invocation.status === "running") : [];
  const visible = active.slice(0, MAX_VISIBLE_WORKERS);
  const advisor = run.strategy.advisor;
  return {
    statusLabel: runStatusLabel(run.status),
    running,
    startedAt: run.createdAt,
    workers: visible.map((invocation) => ({
      id: invocation.id,
      label: `${agentRoleLabel(invocation.role)} · ${invocation.profile}`,
      advisor: invocation.advisor === true,
    })),
    hiddenWorkers: active.length - visible.length,
    tasksDone: run.tasks.filter((task) => task.status === "passed" || task.status === "merged").length,
    tasksTotal: run.tasks.length,
    pendingApprovals: (run.approvals ?? []).filter((approval) => approval.status === "pending").length,
    invocations: { used: run.usage?.agentInvocations ?? 0, max: run.strategy.maxAgentInvocations },
    advisor: advisor?.enabled
      ? { used: run.advisorConsultations ?? 0, max: advisor.maxConsultationsPerRun }
      : undefined,
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
