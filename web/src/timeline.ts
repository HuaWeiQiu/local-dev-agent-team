import { advisorRecommendationLabel, advisorTriggerLabel, agentRoleLabel, jevEntryText, runStatusLabel } from "./presentation";
import type { RunEvent, RunState } from "./types";

export type TimelineKind = "agent" | "advisor" | "flow" | "gate" | "issue";
export type TimelineTone = "success" | "danger" | "warning" | "active" | "neutral";

export interface TimelineEntry {
  key: string;
  at: string;
  kind: TimelineKind;
  tone: TimelineTone;
  title: string;
  detail?: string;
}

export const timelineKindLabels: Record<TimelineKind, string> = {
  agent: "角色",
  advisor: "顾问",
  flow: "流程",
  gate: "审批",
  issue: "异常",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function taskList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === "string");
  if (ids.length === 0) return undefined;
  return ids.length > 4 ? `${ids.slice(0, 4).join("、")} 等 ${ids.length} 个` : ids.join("、");
}

function failureText(value: unknown): string | undefined {
  const failure = record(value);
  return text(failure?.message) ?? text(failure?.reason) ?? text(failure?.kind) ?? text(value);
}

function withDetail(detail: string | undefined): { detail?: string } {
  return detail ? { detail } : {};
}

interface EntryContext {
  base: { key: string; at: string };
  payload: Record<string, unknown> | undefined;
  role: string;
  profile: string | undefined;
}

type Builder = (ctx: EntryContext) => TimelineEntry | undefined;

function contextOf(event: RunEvent): EntryContext {
  const payload = record(event.payload);
  return {
    base: { key: `event:${event.sequence}`, at: event.occurredAt },
    payload,
    role: agentRoleLabel(text(payload?.role) ?? "agent"),
    profile: text(payload?.profile),
  };
}

function fromEvent(event: RunEvent): TimelineEntry | undefined {
  const builder = BUILDERS[event.type];
  if (!builder) return undefined;
  return builder(contextOf(event));
}

/** One builder per event type: the table below is the whole mapping. */
const BUILDERS: Record<string, Builder> = {
  "agent.invocation.started": ({ base, role, profile }) => ({
    ...base,
    kind: "agent",
    tone: "active",
    title: `${role} 开始工作`,
    ...withDetail(profile),
  }),
  "agent.invocation.completed": ({ base, role, profile, payload }) => ({
    ...base,
    kind: "agent",
    tone: payload?.success === true ? "success" : "danger",
    title: `${role} ${payload?.success === true ? "完成" : "失败"}`,
    ...withDetail(profile),
  }),
  "agent.profile.failed": ({ base, role, profile, payload }) => ({
    ...base,
    kind: "issue",
    tone: "danger",
    title: `${role} 调用失败${profile ? `（${profile}）` : ""}`,
    ...withDetail(failureText(payload?.failure)),
  }),
  "agent.profile.skipped": ({ base, role, profile, payload }) => ({
    ...base,
    kind: "issue",
    tone: "warning",
    title: `${role} 跳过 ${profile ?? "候选"}`,
    ...withDetail(text(payload?.reason)),
  }),
  "run.wave.started": ({ base, payload }) => ({
    ...base,
    kind: "flow",
    tone: "active",
    title: "任务批次开始",
    ...withDetail(taskList(payload?.taskIds)),
  }),
  "run.wave.completed": ({ base, payload }) => ({
    ...base,
    kind: "flow",
    tone: waveTone(text(payload?.status)),
    title: "任务批次结束",
    ...withDetail(taskList(payload?.taskIds)),
  }),
  "run.explore.started": ({ base }) => ({
    ...base,
    kind: "flow",
    tone: "active",
    title: "开始探索代码库",
  }),
  "run.explore.completed": ({ base, payload }) => ({
    ...base,
    kind: payload?.success === true ? "flow" : "issue",
    tone: payload?.success === true ? "success" : "warning",
    title: payload?.success === true ? "探索完成" : "探索失败，已继续",
    ...(payload?.success === true ? {} : withDetail(text(payload?.error))),
  }),
  "approval.requested": ({ base, payload }) => ({
    ...base,
    kind: "gate",
    tone: "warning",
    title: "等待人工审批",
    ...withDetail(text(payload?.gate)),
  }),
  "approval.responded": ({ base, payload }) => ({
    ...base,
    kind: "gate",
    tone: payload?.decision === "approved" ? "success" : "danger",
    title: payload?.decision === "approved" ? "审批已通过" : "审批已驳回",
    ...withDetail(
      payload?.decision === "approved"
        ? text(payload?.gate)
        : (text(payload?.reason) ?? text(payload?.gate)),
    ),
  }),
  "run.advisor.consulted": ({ base, payload }) => ({
    ...base,
    kind: "advisor",
    tone: text(payload?.recommendation) === "stop" ? "danger" : "success",
    title: `架构顾问 · ${advisorTriggerLabel(text(payload?.trigger) ?? "")}`,
    ...withDetail(advisorDetail(text(payload?.recommendation), text(payload?.summary))),
  }),
  "run.advisor.skipped": ({ base }) => ({
    ...base,
    kind: "advisor",
    tone: "warning",
    title: "顾问已跳过",
    detail: "达到本次运行的顾问次数上限",
  }),
  "run.advisor.failed": ({ base, payload }) => ({
    ...base,
    kind: "issue",
    tone: "warning",
    title: "顾问调用失败，已放行",
    ...withDetail(text(payload?.error)),
  }),
  "run.jev.decided": ({ base, payload }) => {
    const source = payload?.source;
    if (source !== "jev" && source !== "deterministic") return undefined;
    return {
      ...base,
      kind: "advisor",
      tone: "neutral",
      title: "Jev 分流",
      detail: jevEntryText({
        source,
        ...(text(payload?.decision) ? { decision: text(payload?.decision)! } : {}),
        ...(typeof payload?.confidence === "number" ? { confidence: payload.confidence } : {}),
        consult: payload?.consult === true,
        changedOutcome: payload?.changedOutcome === true,
      }),
    };
  },
  "run.crashed": ({ base, payload }) => ({
    ...base,
    kind: "issue",
    tone: "danger",
    title: "运行崩溃",
    ...withDetail(text(payload?.error)),
  }),
  "run.pause-requested": ({ base }) => ({ ...base, kind: "flow", tone: "neutral", title: "已请求暂停" }),
  "run.cancel-requested": ({ base }) => ({ ...base, kind: "flow", tone: "neutral", title: "已请求取消" }),
  "run.resume-requested": ({ base }) => ({ ...base, kind: "flow", tone: "active", title: "已请求恢复" }),
  "run.recovered": ({ base }) => ({ ...base, kind: "flow", tone: "neutral", title: "已从检查点恢复" }),
};

function waveTone(status: string | undefined): TimelineTone {
  if (status === "blocked") return "danger";
  return status === "rework" ? "warning" : "success";
}

function advisorDetail(recommendation: string | undefined, summary: string | undefined): string | undefined {
  const label = recommendation ? advisorRecommendationLabel(recommendation) : undefined;
  const parts = [label, summary].filter(Boolean);
  return parts.length > 0 ? parts.join("：") : undefined;
}

const historyTone: Record<string, TimelineTone> = {
  completed: "success",
  "ready-to-merge": "success",
  blocked: "danger",
  "ci-failed": "danger",
  cancelled: "neutral",
  interrupted: "neutral",
  reworking: "warning",
};

/**
 * Merges run status history with typed events into one newest-first timeline.
 * Events carry the detail; history supplies the human-readable transition text.
 */
export function deriveTimeline(run: Pick<RunState, "history"> | undefined, events: RunEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const [index, item] of (run?.history ?? []).entries()) {
    entries.push({
      key: `history:${index}`,
      at: item.at,
      kind: "flow",
      tone: historyTone[item.status] ?? "active",
      title: runStatusLabel(item.status),
      detail: item.message,
    });
  }
  for (const event of events) {
    const entry = fromEvent(event);
    if (entry) entries.push(entry);
  }
  return entries.sort((left, right) => right.at.localeCompare(left.at) || right.key.localeCompare(left.key));
}

export function filterTimeline(entries: TimelineEntry[], kinds: ReadonlySet<TimelineKind>): TimelineEntry[] {
  return kinds.size === 0 ? entries : entries.filter((entry) => kinds.has(entry.kind));
}

export function timelineKindCounts(entries: TimelineEntry[]): Record<TimelineKind, number> {
  const counts: Record<TimelineKind, number> = { agent: 0, advisor: 0, flow: 0, gate: 0, issue: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}
