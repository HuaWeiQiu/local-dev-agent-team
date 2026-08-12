import type { RunEvent, RunStatus } from "./types";

export type AgentDisplayStatus =
  | "pending"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "shutdown"
  | "unknown";

export interface ChildAgentActivity {
  id: string;
  threadId: string;
  label: string;
  status: AgentDisplayStatus;
  model?: string;
  reasoning?: string;
  updatedAt: string;
}

export interface AgentInvocationActivity {
  id: string;
  role: string;
  profile: string;
  adapter: string;
  model?: string;
  artifactKey?: string;
  status: AgentDisplayStatus;
  startedAt: string;
  updatedAt: string;
  children: ChildAgentActivity[];
}

const activeRunStatuses = new Set<RunStatus>([
  "created",
  "orchestrating",
  "exploring",
  "architecting",
  "planned",
  "implementing",
  "reviewing-testing",
  "reworking",
  "integrating",
  "final-checks",
  "publishing",
  "waiting-ci",
  "repairing",
]);

const retainedAgentEventTypes = new Set([
  "agent.invocation.started",
  "agent.invocation.completed",
  "agent.children.updated",
]);

export function retainAgentMonitorEvents(events: RunEvent[], maxRecent = 500): RunEvent[] {
  if (events.length <= maxRecent) return events;
  const recentStart = Math.max(0, events.length - maxRecent);
  const retained = new Map<string, RunEvent>();
  for (let index = 0; index < recentStart; index += 1) {
    const event = events[index]!;
    if (!retainedAgentEventTypes.has(event.type)) continue;
    const payload = recordValue(event.payload);
    const invocationId = stringValue(payload?.invocationId);
    if (!invocationId) continue;
    const key = event.type === "agent.children.updated"
      ? `${invocationId}:children`
      : `${invocationId}:${event.type}`;
    retained.set(key, event);
  }
  const bySequence = new Map<number, RunEvent>();
  for (const event of [...retained.values(), ...events.slice(recentStart)]) {
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

export function deriveAgentActivity(
  events: RunEvent[],
  runStatus: RunStatus | undefined,
): AgentInvocationActivity[] {
  const invocations = new Map<string, AgentInvocationActivity>();
  for (const event of events) {
    if (event.type === "agent.invocation.started") {
      const payload = recordValue(event.payload);
      const invocationId = stringValue(payload?.invocationId);
      if (!invocationId) continue;
      const model = stringValue(payload?.model);
      const artifactKey = stringValue(payload?.artifactKey);
      invocations.set(invocationId, {
        id: invocationId,
        role: stringValue(payload?.role) ?? "agent",
        profile: stringValue(payload?.profile) ?? "default",
        adapter: stringValue(payload?.adapter) ?? "unknown",
        ...(model ? { model } : {}),
        ...(artifactKey ? { artifactKey } : {}),
        status: "running",
        startedAt: event.occurredAt,
        updatedAt: event.occurredAt,
        children: [],
      });
      continue;
    }

    if (event.type === "agent.invocation.completed") {
      const payload = recordValue(event.payload);
      const invocationId = stringValue(payload?.invocationId);
      if (!invocationId) continue;
      const existing = invocations.get(invocationId);
      const model = stringValue(payload?.model) ?? existing?.model;
      const artifactKey = stringValue(payload?.artifactKey) ?? existing?.artifactKey;
      invocations.set(invocationId, {
        id: invocationId,
        role: stringValue(payload?.role) ?? existing?.role ?? "agent",
        profile: stringValue(payload?.profile) ?? existing?.profile ?? "default",
        adapter: stringValue(payload?.adapter) ?? existing?.adapter ?? "unknown",
        ...(model ? { model } : {}),
        ...(artifactKey ? { artifactKey } : {}),
        status: payload?.success === true ? "completed" : "failed",
        startedAt: existing?.startedAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        children: existing?.children ?? [],
      });
      continue;
    }

    if (event.type !== "agent.children.updated") continue;
    const payload = recordValue(event.payload);
    const invocationId = stringValue(payload?.invocationId);
    if (!invocationId) continue;
    const existing = invocations.get(invocationId);
    const children = childActivities(payload?.agents, event.occurredAt);
    const artifactKey = stringValue(payload?.artifactKey) ?? existing?.artifactKey;
    invocations.set(invocationId, {
      id: invocationId,
      role: stringValue(payload?.role) ?? existing?.role ?? "agent",
      profile: stringValue(payload?.profile) ?? existing?.profile ?? "default",
      adapter: stringValue(payload?.adapter) ?? existing?.adapter ?? "codex",
      ...(existing?.model ? { model: existing.model } : {}),
      ...(artifactKey ? { artifactKey } : {}),
      status: existing?.status ?? "running",
      startedAt: existing?.startedAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      children,
    });
  }

  if (runStatus && !activeRunStatuses.has(runStatus)) {
    for (const [id, invocation] of invocations) {
      const children = invocation.children.map((child) =>
        child.status === "running" || child.status === "pending"
          ? { ...child, status: "interrupted" as const }
          : child,
      );
      const status = invocation.status === "running" || invocation.status === "pending"
        ? "interrupted"
        : invocation.status;
      invocations.set(id, { ...invocation, status, children });
    }
  }

  return [...invocations.values()].sort((left, right) => {
    const leftActive = Number(left.status === "running" || left.status === "pending");
    const rightActive = Number(right.status === "running" || right.status === "pending");
    return rightActive - leftActive || right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function agentStatusLabel(status: AgentDisplayStatus): string {
  return {
    pending: "启动中",
    running: "执行中",
    completed: "已完成",
    interrupted: "已中断",
    failed: "失败",
    shutdown: "已关闭",
    unknown: "未知",
  }[status];
}

export { agentRoleLabel } from "./presentation";

function childActivities(value: unknown, updatedAt: string): ChildAgentActivity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const child = recordValue(candidate);
    const threadId = stringValue(child?.threadId);
    if (!threadId) return [];
    const path = stringValue(child?.path);
    const label = path?.split("/").filter(Boolean).at(-1) ?? `Codex ${shortId(threadId)}`;
    const status = agentDisplayStatus(child?.status);
    const model = stringValue(child?.model);
    const reasoning = stringValue(child?.reasoning);
    return [{
      id: threadId,
      threadId,
      label,
      status,
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning } : {}),
      updatedAt,
    }];
  }).sort((left, right) => left.label.localeCompare(right.label));
}

function agentDisplayStatus(value: unknown): AgentDisplayStatus {
  return ["pending", "running", "completed", "interrupted", "failed", "shutdown"]
    .includes(String(value))
    ? value as AgentDisplayStatus
    : "unknown";
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
