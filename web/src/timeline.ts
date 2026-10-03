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

function fromEvent(event: RunEvent): TimelineEntry | undefined {
  const payload = record(event.payload);
  const base = { key: `event:${event.sequence}`, at: event.occurredAt };
  const role = agentRoleLabel(text(payload?.role) ?? "agent");
  const profile = text(payload?.profile);

  switch (event.type) {
    case "agent.invocation.started":
      return { ...base, kind: "agent", tone: "active", title: `${role} 开始工作`, ...withDetail(profile) };
    case "agent.invocation.completed":
      return payload?.success === true
        ? { ...base, kind: "agent", tone: "success", title: `${role} 完成`, ...withDetail(profile) }
        : { ...base, kind: "agent", tone: "danger", title: `${role} 失败`, ...withDetail(profile) };
    case "agent.profile.failed":
      return {
        ...base,
        kind: "issue",
        tone: "danger",
        title: `${role} 调用失败${profile ? `（${profile}）` : ""}`,
        ...withDetail(failureText(payload?.failure)),
      };
    case "agent.profile.skipped":
      return {
        ...base,
        kind: "issue",
        tone: "warning",
        title: `${role} 跳过 ${profile ?? "候选"}`,
        ...withDetail(text(payload?.reason)),
      };
    case "run.wave.started":
      return { ...base, kind: "flow", tone: "active", title: "任务批次开始", ...withDetail(taskList(payload?.taskIds)) };
    case "run.wave.completed": {
      const status = text(payload?.status);
      const tone: TimelineTone = status === "blocked" ? "danger" : status === "rework" ? "warning" : "success";
      return { ...base, kind: "flow", tone, title: "任务批次结束", ...withDetail(taskList(payload?.taskIds)) };
    }
    case "run.explore.started":
      return { ...base, kind: "flow", tone: "active", title: "开始探索代码库" };
    case "run.explore.completed":
      return payload?.success === true
        ? { ...base, kind: "flow", tone: "success", title: "探索完成" }
        : { ...base, kind: "issue", tone: "warning", title: "探索失败，已继续", ...withDetail(text(payload?.error)) };
    case "approval.requested":
      return { ...base, kind: "gate", tone: "warning", title: "等待人工审批", ...withDetail(text(payload?.gate)) };
    case "approval.responded":
      return payload?.decision === "approved"
        ? { ...base, kind: "gate", tone: "success", title: "审批已通过", ...withDetail(text(payload?.gate)) }
        : { ...base, kind: "gate", tone: "danger", title: "审批已驳回", ...withDetail(text(payload?.reason) ?? text(payload?.gate)) };
    case "run.advisor.consulted": {
      const trigger = advisorTriggerLabel(text(payload?.trigger) ?? "");
      const recommendation = text(payload?.recommendation);
      return {
        ...base,
        kind: "advisor",
        tone: recommendation === "stop" ? "danger" : "success",
        title: `架构顾问 · ${trigger}`,
        ...withDetail(
          [recommendation ? advisorRecommendationLabel(recommendation) : undefined, text(payload?.summary)]
            .filter(Boolean)
            .join("：") || undefined,
        ),
      };
    }
    case "run.advisor.skipped":
      return { ...base, kind: "advisor", tone: "warning", title: "顾问已跳过", detail: "达到本次运行的顾问次数上限" };
    case "run.advisor.failed":
      return {
        ...base,
        kind: "issue",
        tone: "warning",
        title: "顾问调用失败，已放行",
        ...withDetail(text(payload?.error)),
      };
    case "run.jev.decided": {
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
    }
    case "run.crashed":
      return { ...base, kind: "issue", tone: "danger", title: "运行崩溃", ...withDetail(text(payload?.error)) };
    case "run.pause-requested":
      return { ...base, kind: "flow", tone: "neutral", title: "已请求暂停" };
    case "run.cancel-requested":
      return { ...base, kind: "flow", tone: "neutral", title: "已请求取消" };
    case "run.resume-requested":
      return { ...base, kind: "flow", tone: "active", title: "已请求恢复" };
    case "run.recovered":
      return { ...base, kind: "flow", tone: "neutral", title: "已从检查点恢复" };
    default:
      return undefined;
  }
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
