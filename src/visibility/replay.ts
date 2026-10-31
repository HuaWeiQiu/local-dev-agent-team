import type { RunEvent } from "../events/types.js";
import type { FlowSelection, TriageEvent } from "../flow/types.js";
import type { RunState } from "../state/types.js";

export type ReplayKind =
  | "status"
  | "flow"
  | "triage"
  | "agent"
  | "operator"
  | "quality"
  | "approval"
  | "advice"
  | "wave";

export interface ReplayStep {
  at: string;
  /** Milliseconds since the first step, for a time-proportional scrubber. */
  offsetMs: number;
  kind: ReplayKind;
  tone: "good" | "warn" | "bad" | "neutral";
  title: string;
  detail?: string;
  taskId?: string;
  nodeId?: string;
}

const MAX_STEPS = 4_000;

type Draft = Omit<ReplayStep, "offsetMs">;

function fromEvent(event: RunEvent): Draft | undefined {
  const at = event.occurredAt;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;
  const taskId = text("taskId");
  const task = taskId ? { taskId } : {};

  switch (event.type) {
    case "flow.selected": {
      const selection = event.payload as FlowSelection;
      return {
        at,
        kind: "flow",
        tone: "neutral",
        title: `选择流程 ${selection.template}`,
        detail: selection.reasons.join("；"),
      };
    }
    case "flow.node": {
      const status = text("status") ?? "";
      const nodeId = text("nodeId") ?? "";
      const tone = status === "failed" ? "bad" : status === "parked" ? "warn" : status === "completed" ? "good" : "neutral";
      return {
        at,
        kind: "flow",
        tone,
        title: `${nodeId} ${status}`,
        nodeId,
        ...(text("reason") ? { detail: text("reason")! } : {}),
      };
    }
    case "flow.triage": {
      const item = event.payload as TriageEvent;
      return {
        at,
        kind: "triage",
        tone: item.decision === "stop" ? "bad" : "neutral",
        title: `${item.taskId} 第 ${item.attempt} 次尝试前：${item.decision}`,
        detail: item.reason,
        taskId: item.taskId,
      };
    }
    case "quality.flaky":
      return {
        at,
        kind: "quality",
        tone: "warn",
        title: "质量命令重跑后通过（不稳定）",
        detail: Array.isArray(payload.commands) ? (payload.commands as string[]).join("；") : undefined!,
        ...task,
      };
    case "agent.invocation.completed": {
      const success = payload.success !== false;
      const seconds = typeof payload.durationMs === "number" ? `${(payload.durationMs / 1000).toFixed(1)}s` : "";
      return {
        at,
        kind: "agent",
        tone: success ? "neutral" : "bad",
        title: `${text("role") ?? "agent"} ${success ? "完成" : "失败"}${seconds ? `（${seconds}）` : ""}`,
        ...(text("error") ? { detail: text("error")! } : {}),
        ...(text("artifactKey") ? { taskId: /tasks\/([^/]+)\//.exec(text("artifactKey")!)?.[1] ?? undefined! } : {}),
      };
    }
    case "agent.stalled":
      return { at, kind: "operator", tone: "warn", title: `${text("role") ?? "agent"} 长时间无输出，已催促继续`, ...task };
    case "agent.steered":
      return { at, kind: "operator", tone: "neutral", title: `${text("actor") ?? "操作者"} 引导了 ${text("role") ?? "agent"}`, detail: text("text")!, ...task };
    case "agent.interrupted":
      return {
        at,
        kind: "operator",
        tone: "warn",
        title: `${text("actor") ?? "操作者"} 中断了 ${text("role") ?? "agent"}`,
        ...(text("note") ? { detail: text("note")! } : {}),
        ...task,
      };
    case "agent.question":
      return { at, kind: "operator", tone: "warn", title: `${text("role") ?? "agent"} 提问`, detail: text("prompt")!, ...task };
    case "agent.answered":
      return { at, kind: "operator", tone: "neutral", title: `${text("actor") ?? "操作者"} 回答了提问` };
    case "plan.edited":
      return { at, kind: "operator", tone: "neutral", title: `${text("actor") ?? "操作者"} 编辑了计划`, ...(text("reason") ? { detail: text("reason")! } : {}) };
    case "approval.requested":
      return { at, kind: "approval", tone: "warn", title: `等待审批：${text("gate") ?? ""}` };
    case "approval.responded":
      return {
        at,
        kind: "approval",
        tone: payload.decision === "approved" ? "good" : "bad",
        title: `${text("actor") ?? "操作者"} ${payload.decision === "approved" ? "批准" : "拒绝"}了 ${text("gate") ?? ""}`,
        ...(text("comment") ? { detail: text("comment")! } : {}),
      };
    case "run.advisor.consulted":
      return {
        at,
        kind: "advice",
        tone: payload.recommendation === "stop" ? "bad" : "neutral",
        title: `架构顾问：${text("recommendation") ?? ""}`,
        detail: text("summary")!,
        ...task,
      };
    case "run.jev.decided":
      return {
        at,
        kind: "advice",
        tone: "neutral",
        title: `Jev 判断：${payload.consult === true ? "咨询架构顾问" : "继续重试"}`,
        detail: text("reason")!,
        ...task,
      };
    case "run.wave.started":
      return { at, kind: "wave", tone: "neutral", title: `开始并行波次：${Array.isArray(payload.taskIds) ? (payload.taskIds as string[]).join(", ") : ""}` };
    case "run.wave.completed":
      return {
        at,
        kind: "wave",
        tone: payload.status === "failed" || payload.status === "blocked" ? "bad" : "good",
        title: `波次${text("status") ?? "结束"}：${Array.isArray(payload.taskIds) ? (payload.taskIds as string[]).join(", ") : ""}`,
      };
    default:
      return undefined;
  }
}

function clean(draft: Draft): Draft {
  return Object.fromEntries(
    Object.entries(draft).filter(([, value]) => value !== undefined),
  ) as Draft;
}

/**
 * A time-ordered narrative of the run built from the state history and the
 * ledger. It is a projection: replaying it changes nothing.
 */
export function buildReplay(state: RunState, events: readonly RunEvent[]): ReplayStep[] {
  const drafts: Draft[] = [];
  for (const entry of state.history) {
    drafts.push({
      at: entry.at,
      kind: "status",
      tone: entry.status === "blocked" || entry.status === "ci-failed" ? "bad" : entry.status === "completed" ? "good" : "neutral",
      title: entry.message,
    });
  }
  for (const event of events) {
    const draft = fromEvent(event);
    if (draft) drafts.push(clean(draft));
  }
  drafts.sort((left, right) => left.at.localeCompare(right.at));
  const bounded = drafts.length > MAX_STEPS ? drafts.slice(-MAX_STEPS) : drafts;
  const origin = bounded.length > 0 ? Date.parse(bounded[0]!.at) : 0;
  return bounded.map((draft) => ({
    ...draft,
    offsetMs: Math.max(0, Date.parse(draft.at) - origin),
  }));
}
