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

interface DraftContext {
  at: string;
  payload: Record<string, unknown>;
  text(key: string): string | undefined;
  task: { taskId?: string };
}

type DraftBuilder = (ctx: DraftContext) => Draft | undefined;

function contextOf(event: RunEvent): DraftContext {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;
  const taskId = text("taskId");
  return { at: event.occurredAt, payload, text, task: taskId ? { taskId } : {} };
}

/** One builder per ledger event type; unknown events are not replayable. */
function fromEvent(event: RunEvent): Draft | undefined {
  const builder = BUILDERS[event.type];
  if (!builder) return undefined;
  return builder(contextOf(event));
}

const BUILDERS: Record<string, DraftBuilder> = {
  "flow.selected": ({ at, payload }) => {
    const selection = payload as unknown as FlowSelection;
    return {
      at,
      kind: "flow",
      tone: "neutral",
      title: `选择流程 ${selection.template}`,
      detail: selection.reasons.join("；"),
    };
  },
  "flow.node": ({ at, text }) => {
    const status = text("status") ?? "";
    const nodeId = text("nodeId") ?? "";
    return {
      at,
      kind: "flow",
      tone: flowTone(status),
      title: `${nodeId} ${status}`,
      nodeId,
      ...(text("reason") ? { detail: text("reason")! } : {}),
    };
  },
  "flow.triage": ({ at, payload }) => {
    const item = payload as unknown as TriageEvent;
    return {
      at,
      kind: "triage",
      tone: item.decision === "stop" ? "bad" : "neutral",
      title: `${item.taskId} 第 ${item.attempt} 次尝试前：${item.decision}`,
      detail: item.reason,
      taskId: item.taskId,
    };
  },
  "quality.flaky": ({ at, payload, task }) => ({
    at,
    kind: "quality",
    tone: "warn",
    title: "质量命令重跑后通过（不稳定）",
    ...commandDetail(payload),
    ...task,
  }),
  "agent.invocation.completed": ({ at, text, payload }) => {
    const success = payload.success !== false;
    const duration = typeof payload.durationMs === "number" ? payload.durationMs : undefined;
    return {
      at,
      kind: "agent",
      tone: success ? "neutral" : "bad",
      title: `${text("role") ?? "agent"} ${success ? "完成" : "失败"}${durationSuffix(duration)}`,
      ...(text("error") ? { detail: text("error")! } : {}),
      ...artifactTask(text("artifactKey")),
    };
  },
  "agent.stalled": ({ at, text, task }) => ({
    at,
    kind: "operator",
    tone: "warn",
    title: `${text("role") ?? "agent"} 长时间无输出，已催促继续`,
    ...task,
  }),
  "agent.steered": ({ at, text, task }) => ({
    at,
    kind: "operator",
    tone: "neutral",
    title: `${text("actor") ?? "操作者"} 引导了 ${text("role") ?? "agent"}`,
    ...(text("text") ? { detail: text("text")! } : {}),
    ...task,
  }),
  "agent.interrupted": ({ at, text, task }) => ({
    at,
    kind: "operator",
    tone: "warn",
    title: `${text("actor") ?? "操作者"} 中断了 ${text("role") ?? "agent"}`,
    ...(text("note") ? { detail: text("note")! } : {}),
    ...task,
  }),
  "agent.question": ({ at, text, task }) => ({
    at,
    kind: "operator",
    tone: "warn",
    title: `${text("role") ?? "agent"} 提问`,
    ...(text("prompt") ? { detail: text("prompt")! } : {}),
    ...task,
  }),
  "agent.answered": ({ at, text }) => ({
    at,
    kind: "operator",
    tone: "neutral",
    title: `${text("actor") ?? "操作者"} 回答了提问`,
  }),
  "plan.edited": ({ at, text }) => ({
    at,
    kind: "operator",
    tone: "neutral",
    title: `${text("actor") ?? "操作者"} 编辑了计划`,
    ...(text("reason") ? { detail: text("reason")! } : {}),
  }),
  "approval.requested": ({ at, text }) => ({
    at,
    kind: "approval",
    tone: "warn",
    title: `等待审批：${text("gate") ?? ""}`,
  }),
  "approval.responded": ({ at, text, payload }) => ({
    at,
    kind: "approval",
    tone: payload.decision === "approved" ? "good" : "bad",
    title: `${text("actor") ?? "操作者"} ${payload.decision === "approved" ? "批准" : "拒绝"}了 ${text("gate") ?? ""}`,
    ...(text("comment") ? { detail: text("comment")! } : {}),
  }),
  "run.advisor.consulted": ({ at, text, payload, task }) => ({
    at,
    kind: "advice",
    tone: payload.recommendation === "stop" ? "bad" : "neutral",
    title: `架构顾问：${text("recommendation") ?? ""}`,
    ...(text("summary") ? { detail: text("summary")! } : {}),
    ...task,
  }),
  "run.jev.decided": ({ at, text, payload, task }) => ({
    at,
    kind: "advice",
    tone: "neutral",
    title: `Jev 判断：${payload.consult === true ? "咨询架构顾问" : "继续重试"}`,
    ...(text("reason") ? { detail: text("reason")! } : {}),
    ...task,
  }),
  "run.wave.started": ({ at, payload }) => ({
    at,
    kind: "wave",
    tone: "neutral",
    title: `开始并行波次：${taskIdsOf(payload)}`,
  }),
  "run.wave.completed": ({ at, text, payload }) => ({
    at,
    kind: "wave",
    tone: payload.status === "failed" || payload.status === "blocked" ? "bad" : "good",
    title: `波次${text("status") ?? "结束"}：${taskIdsOf(payload)}`,
  }),
};

function commandDetail(payload: Record<string, unknown>): { detail?: string } {
  if (!Array.isArray(payload.commands)) return {};
  const commands = payload.commands as string[];
  return commands.length > 0 ? { detail: commands.join("；") } : {};
}

function flowTone(status: string): ReplayStep["tone"] {
  if (status === "failed") return "bad";
  if (status === "parked") return "warn";
  return status === "completed" ? "good" : "neutral";
}

function durationSuffix(duration: number | undefined): string {
  return duration === undefined ? "" : `（${(duration / 1000).toFixed(1)}s）`;
}

function taskFromArtifact(artifactKey: string): string | undefined {
  return /tasks\/([^/]+)\//.exec(artifactKey)?.[1];
}

function artifactTask(artifactKey: string | undefined): { taskId?: string } {
  if (!artifactKey) return {};
  const taskId = taskFromArtifact(artifactKey);
  return taskId ? { taskId } : {};
}

function taskIdsOf(payload: Record<string, unknown>): string {
  return Array.isArray(payload.taskIds) ? (payload.taskIds as string[]).join(", ") : "";
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
  const drafts = [...historyDrafts(state), ...eventDrafts(events)];
  drafts.sort((left, right) => left.at.localeCompare(right.at));
  const bounded = boundSteps(drafts);
  const origin = bounded.length > 0 ? Date.parse(bounded[0]!.at) : 0;
  return bounded.map((draft) => stampOffset(draft, origin));
}

function historyDrafts(state: RunState): Draft[] {
  return state.history.map((entry) => ({
    at: entry.at,
    kind: "status",
    tone: statusTone(entry.status),
    title: entry.message,
  }));
}

function eventDrafts(events: readonly RunEvent[]): Draft[] {
  const drafts: Draft[] = [];
  for (const event of events) {
    const draft = fromEvent(event);
    if (draft) drafts.push(clean(draft));
  }
  return drafts;
}

function statusTone(status: string): Draft["tone"] {
  if (status === "blocked" || status === "ci-failed") return "bad";
  return status === "completed" ? "good" : "neutral";
}

function boundSteps(drafts: Draft[]): Draft[] {
  return drafts.length > MAX_STEPS ? drafts.slice(-MAX_STEPS) : drafts;
}

function stampOffset(draft: Draft, origin: number): ReplayStep {
  return { ...draft, offsetMs: Math.max(0, Date.parse(draft.at) - origin) };
}
