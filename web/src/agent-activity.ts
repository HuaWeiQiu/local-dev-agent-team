import { isAdvisorArtifactKey } from "./presentation";
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
  /** True for read-only architect advisor consultations. */
  advisor?: true;
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
    if (event.type in advisorEventStatus) {
      // Advisor consultations are rare and bounded per run; keep them all.
      retained.set(`advisor:${event.sequence}`, event);
      continue;
    }
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
  for (const event of events) applyEvent(invocations, event);
  interruptStale(invocations, runStatus);
  return sortActivities(markAdvisors([...invocations.values()]));
}

function applyEvent(
  invocations: Map<string, AgentInvocationActivity>,
  event: RunEvent,
): void {
  const payload = recordValue(event.payload);
  const invocationId = stringValue(payload?.invocationId);
  if (!invocationId) return;
  if (event.type === "agent.invocation.started") {
    invocations.set(invocationId, startedActivity(invocationId, payload, event));
    return;
  }
  if (event.type === "agent.invocation.completed") {
    invocations.set(invocationId, completedActivity(invocationId, payload, event, invocations));
    return;
  }
  if (event.type === "agent.children.updated") {
    invocations.set(invocationId, childrenActivity(invocationId, payload, event, invocations));
  }
}

/** Every activity shares the same envelope: identity, defaults, timestamps. */
function activityEnvelope(
  invocationId: string,
  payload: Record<string, unknown> | undefined,
  existing: AgentInvocationActivity | undefined,
  event: RunEvent,
  adapterFallback: string,
): Omit<AgentInvocationActivity, "status" | "children"> {
  const model = inherited(payload, existing, "model");
  const artifactKey = inherited(payload, existing, "artifactKey");
  return {
    id: invocationId,
    role: inherited(payload, existing, "role") ?? "agent",
    profile: inherited(payload, existing, "profile") ?? "default",
    adapter: inherited(payload, existing, "adapter") ?? adapterFallback,
    ...(model ? { model } : {}),
    ...(artifactKey ? { artifactKey } : {}),
    ...timestampFields(existing, event),
  };
}

function timestampFields(
  existing: AgentInvocationActivity | undefined,
  event: RunEvent,
): Pick<AgentInvocationActivity, "startedAt" | "updatedAt"> {
  return {
    startedAt: existing?.startedAt ?? event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

/** A payload field wins over the copy already on the activity. */
function inherited(
  payload: Record<string, unknown> | undefined,
  existing: AgentInvocationActivity | undefined,
  field: "role" | "profile" | "adapter" | "model" | "artifactKey",
): string | undefined {
  return stringValue(payload?.[field]) ?? existing?.[field];
}

function startedActivity(
  invocationId: string,
  payload: Record<string, unknown> | undefined,
  event: RunEvent,
): AgentInvocationActivity {
  return {
    ...activityEnvelope(invocationId, payload, undefined, event, "unknown"),
    status: "running",
    children: [],
  };
}

function completedActivity(
  invocationId: string,
  payload: Record<string, unknown> | undefined,
  event: RunEvent,
  invocations: Map<string, AgentInvocationActivity>,
): AgentInvocationActivity {
  const existing = invocations.get(invocationId);
  return {
    ...activityEnvelope(invocationId, payload, existing, event, "unknown"),
    status: payload?.success === true ? "completed" : "failed",
    children: existing?.children ?? [],
  };
}

function childrenActivity(
  invocationId: string,
  payload: Record<string, unknown> | undefined,
  event: RunEvent,
  invocations: Map<string, AgentInvocationActivity>,
): AgentInvocationActivity {
  const existing = invocations.get(invocationId);
  return {
    ...activityEnvelope(invocationId, payload, existing, event, "codex"),
    status: existing?.status ?? "running",
    children: childActivities(payload?.agents, event.occurredAt),
  };
}

/** Nothing is still running once the run reached a resting status. */
function interruptStale(
  invocations: Map<string, AgentInvocationActivity>,
  runStatus: RunStatus | undefined,
): void {
  if (!runStatus || activeRunStatuses.has(runStatus)) return;
  for (const [id, invocation] of invocations) {
    invocations.set(id, {
      ...invocation,
      status: isActive(invocation.status) ? "interrupted" : invocation.status,
      children: invocation.children.map((child) =>
        isActive(child.status) ? { ...child, status: "interrupted" as const } : child,
      ),
    });
  }
}

function isActive(status: string): boolean {
  return status === "running" || status === "pending";
}

/** Advisor consultations are marked so the UI can separate them. */
function markAdvisors(
  invocations: AgentInvocationActivity[],
): AgentInvocationActivity[] {
  return invocations.map((invocation) =>
    isAdvisorArtifactKey(invocation.artifactKey)
      ? { ...invocation, advisor: true as const }
      : invocation,
  );
}

/** Running first, then most recently updated. */
function sortActivities(
  invocations: AgentInvocationActivity[],
): AgentInvocationActivity[] {
  return invocations.sort((left, right) => {
    const byActivity = Number(isActive(right.status)) - Number(isActive(left.status));
    return byActivity || right.updatedAt.localeCompare(left.updatedAt);
  });
}

export type AdvisorLogStatus = "consulted" | "skipped" | "failed" | "jev";

export interface AdvisorLogEntry {
  sequence: number;
  status: AdvisorLogStatus;
  trigger: string;
  taskId?: string;
  recommendation?: string;
  summary?: string;
  detail?: string;
  occurredAt: string;
  jev?: {
    source: "jev" | "deterministic";
    decision?: string;
    confidence?: number;
    consult: boolean;
    changedOutcome: boolean;
    latencyMs?: number;
  };
}

const advisorEventStatus: Record<string, AdvisorLogStatus> = {
  "run.advisor.consulted": "consulted",
  "run.advisor.skipped": "skipped",
  "run.advisor.failed": "failed",
  "run.jev.decided": "jev",
};

function deriveJevEntry(event: RunEvent): AdvisorLogEntry | undefined {
  const payload = recordValue(event.payload);
  const source = jevSource(payload?.source);
  if (!source) return undefined;
  const taskId = stringValue(payload?.taskId);
  const detail = stringValue(payload?.reason);
  return {
    ...advisorEnvelope(event, "jev", "jev"),
    ...(taskId ? { taskId } : {}),
    ...(detail ? { detail } : {}),
    jev: jevDetail(payload, source),
  };
}

function jevSource(value: unknown): "jev" | "deterministic" | undefined {
  return value === "jev" || value === "deterministic" ? value : undefined;
}

function jevDetail(
  payload: Record<string, unknown> | undefined,
  source: "jev" | "deterministic",
): NonNullable<AdvisorLogEntry["jev"]> {
  const decision = stringValue(payload?.decision);
  const confidence = numberValue(payload?.confidence);
  const latencyMs = numberValue(payload?.latencyMs);
  return {
    source,
    ...(decision ? { decision } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    consult: payload?.consult === true,
    changedOutcome: payload?.changedOutcome === true,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}

/** The fields every advisor log line carries. */
function advisorEnvelope(
  event: RunEvent,
  status: AdvisorLogStatus,
  trigger: string,
): Pick<AdvisorLogEntry, "sequence" | "status" | "trigger" | "occurredAt"> {
  return { sequence: event.sequence, status, trigger, occurredAt: event.occurredAt };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Newest-first architect advisor consultations and Jev fork decisions derived from run events. */
export function deriveAdvisorLog(events: RunEvent[]): AdvisorLogEntry[] {
  return events
    .flatMap((event) => advisorEntry(event) ?? [])
    .sort((left, right) => right.sequence - left.sequence);
}

function advisorEntry(event: RunEvent): AdvisorLogEntry[] | undefined {
  const status = advisorEventStatus[event.type];
  if (status === "jev") return deriveJevEntry(event) ? [deriveJevEntry(event)!] : undefined;
  if (!status) return undefined;
  const payload = recordValue(event.payload);
  const trigger = stringValue(payload?.trigger);
  if (!trigger) return undefined;
  return [consultationEntry(event, payload, status, trigger)];
}

function consultationEntry(
  event: RunEvent,
  payload: Record<string, unknown> | undefined,
  status: AdvisorLogStatus,
  trigger: string,
): AdvisorLogEntry {
  return { ...advisorEnvelope(event, status, trigger), ...consultationDetails(payload) };
}

/** Only the fields the server actually sent are copied onto the entry. */
function consultationDetails(
  payload: Record<string, unknown> | undefined,
): Partial<AdvisorLogEntry> {
  return {
    ...present("taskId", stringValue(payload?.taskId)),
    ...present("recommendation", stringValue(payload?.recommendation)),
    ...present("summary", stringValue(payload?.summary)),
    ...present("detail", stringValue(payload?.error) ?? stringValue(payload?.reason)),
  };
}

function present<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value ? ({ [key]: value } as Record<K, string>) : {};
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
  return value
    .flatMap((candidate) => childActivity(candidate, updatedAt) ?? [])
    .sort((left, right) => left.label.localeCompare(right.label));
}

function childActivity(
  candidate: unknown,
  updatedAt: string,
): ChildAgentActivity[] | undefined {
  const child = recordValue(candidate);
  const threadId = stringValue(child?.threadId);
  if (!threadId) return undefined;
  return [
    {
      id: threadId,
      threadId,
      label: childLabel(child?.path, threadId),
      status: agentDisplayStatus(child?.status),
      ...childModelFields(child),
      updatedAt,
    },
  ];
}

function childModelFields(child: Record<string, unknown> | undefined): {
  model?: string;
  reasoning?: string;
} {
  return {
    ...present("model", stringValue(child?.model)),
    ...present("reasoning", stringValue(child?.reasoning)),
  };
}

/** The last path segment names the child; otherwise fall back to its id. */
function childLabel(path: unknown, threadId: string): string {
  const segment = stringValue(path)?.split("/").filter(Boolean).at(-1);
  return segment ?? `Codex ${shortId(threadId)}`;
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
