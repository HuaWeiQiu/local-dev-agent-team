import type { FlowSelection, TriageEvent } from "../flow/types.js";
import type { RunEvent } from "../events/types.js";
import type { CommandResult } from "../quality/run.js";
import type { RunState, TaskRunState } from "../state/types.js";

export type ExplainTone = "good" | "warn" | "bad" | "neutral";

export interface ExplainLine {
  tone: ExplainTone;
  text: string;
}

export interface TaskExplanation {
  taskId: string;
  title: string;
  status: string;
  tone: ExplainTone;
  /** One sentence that answers "why is this task in this state". */
  summary: string;
  lines: ExplainLine[];
}

export interface RunExplanation {
  headline: ExplainLine;
  flow?: { template: string; source: string; reasons: string[] };
  run: ExplainLine[];
  tasks: TaskExplanation[];
}

const TASK_TONE: Record<string, ExplainTone> = {
  merged: "good",
  passed: "good",
  blocked: "bad",
  failed: "bad",
  working: "neutral",
  reworking: "warn",
  reviewing: "neutral",
  testing: "neutral",
  pending: "neutral",
};

function commandLabel(result: CommandResult): string {
  return [result.spec.command, ...result.spec.args].join(" ").slice(0, 120);
}

function qualityLines(task: TaskRunState): ExplainLine[] {
  const quality = task.quality;
  if (!quality) return [];
  const lines: ExplainLine[] = [];
  if (quality.passed) {
    lines.push({
      tone: "good",
      text: quality.commands.length === 0
        ? "没有配置质量命令，确定性门禁为空"
        : `质量门禁通过（${quality.commands.length} 条命令）`,
    });
  } else {
    const failed = quality.commands.find((command) => command.exitCode !== 0);
    lines.push({
      tone: "bad",
      text: failed
        ? `质量命令失败：${commandLabel(failed)}（${failed.timedOut ? "超时" : `退出码 ${String(failed.exitCode)}`}）`
        : "质量门禁未通过",
    });
  }
  if (quality.flaky?.length) {
    lines.push({
      tone: "warn",
      text: `重跑后通过，判定为不稳定：${quality.flaky.map((spec) => [spec.command, ...spec.args].join(" ").slice(0, 80)).join("；")}`,
    });
  }
  return lines;
}

function verdictLines(task: TaskRunState): ExplainLine[] {
  const lines: ExplainLine[] = [];
  const verdictTone = (verdict: string): ExplainTone =>
    verdict === "approve" ? "good" : verdict === "request_changes" ? "warn" : "bad";
  if (task.review) {
    const required = task.review.findings.filter((finding) => finding.required);
    lines.push({
      tone: verdictTone(task.review.verdict),
      text: `评审 ${task.review.verdict}：${task.review.summary}${
        required.length > 0 ? `（${required.length} 项必须修复）` : ""
      }`,
    });
    for (const finding of required.slice(0, 3)) {
      lines.push({
        tone: "warn",
        text: `${finding.path}${finding.line ? `:${finding.line}` : ""} ${finding.message}`,
      });
    }
  }
  if (task.test) {
    lines.push({
      tone: verdictTone(task.test.verdict),
      text: `测试 ${task.test.verdict}：${task.test.summary}${
        task.test.missingTests.length > 0 ? `（缺少 ${task.test.missingTests.length} 项测试）` : ""
      }`,
    });
  }
  return lines;
}

function triageLine(item: TriageEvent): ExplainLine {
  const where = `第 ${item.attempt} 次尝试前`;
  if (item.decision === "stop") {
    return { tone: "bad", text: `${where}停止：${item.reason}` };
  }
  if (item.decision === "consult") {
    return { tone: "neutral", text: `${where}咨询架构顾问（${item.source}）：${item.reason}` };
  }
  return { tone: "neutral", text: `${where}重试：${item.reason}` };
}

function explainTask(task: TaskRunState, triage: TriageEvent[]): TaskExplanation {
  const lines: ExplainLine[] = [];
  lines.push(...qualityLines(task));
  lines.push(...verdictLines(task));
  for (const item of triage.filter((entry) => entry.taskId === task.task.id)) {
    lines.push(triageLine(item));
  }
  if (task.error) lines.push({ tone: "bad", text: task.error });

  let summary: string;
  if (task.status === "merged" || task.status === "passed") {
    summary = task.attempts > 1
      ? `经过 ${task.attempts} 次尝试后通过全部门禁并合并`
      : "一次通过全部门禁并合并";
  } else if (task.status === "blocked") {
    summary = task.error ? task.error : "任务被阻塞";
  } else if (task.status === "pending") {
    summary = "尚未开始";
  } else {
    summary = `进行中（第 ${task.attempts} 次尝试）`;
  }
  return {
    taskId: task.task.id,
    title: task.task.title,
    status: task.status,
    tone: TASK_TONE[task.status] ?? "neutral",
    summary,
    lines,
  };
}

function headlineFor(state: RunState, tasks: TaskExplanation[]): ExplainLine {
  const blocked = tasks.filter((task) => task.status === "blocked");
  const merged = tasks.filter((task) => task.status === "merged").length;
  if (state.status === "completed") {
    return { tone: "good", text: `已完成：${merged}/${tasks.length} 个任务已合并` };
  }
  if (state.status === "cancelled") return { tone: "neutral", text: "已被操作者取消" };
  if (blocked.length > 0 || state.status === "blocked") {
    const first = blocked[0];
    return {
      tone: "bad",
      text: first
        ? `已阻塞：任务 ${first.taskId} ${first.summary}`
        : `已阻塞${state.error ? `：${state.error}` : ""}`,
    };
  }
  if (state.finalQuality && !state.finalQuality.passed) {
    return { tone: "bad", text: "最终质量命令失败，确定性检查否决交付，模型判定无法覆盖" };
  }
  if (state.finalDecision?.decision === "escalate") {
    return { tone: "warn", text: `需要人工判断：${state.finalDecision.reason}` };
  }
  if (state.status === "awaiting-human" || state.status === "ready-to-merge") {
    return {
      tone: "good",
      text: `可以交付：${merged}/${tasks.length} 个任务已合并，等待你核对并批准`,
    };
  }
  return { tone: "neutral", text: `进行中：${state.status}（${merged}/${tasks.length} 个任务已合并）` };
}

/**
 * Answers "why is the run in this state" from recorded facts only: task
 * results, deterministic gate output and ledger decisions. It never asks a
 * model, so the explanation cannot disagree with the evidence.
 */
export function explainRun(state: RunState, events: readonly RunEvent[]): RunExplanation {
  const triage = events
    .filter((event) => event.type === "flow.triage")
    .map((event) => event.payload as TriageEvent);
  const tasks = state.tasks.map((task) => explainTask(task, triage));
  const run: ExplainLine[] = [];

  if (state.finalQuality) {
    const failed = state.finalQuality.commands.find((command) => command.exitCode !== 0);
    run.push(
      state.finalQuality.passed
        ? { tone: "good", text: "最终集成质量门禁通过" }
        : {
            tone: "bad",
            text: `最终集成质量门禁失败${failed ? `：${commandLabel(failed)}` : ""}`,
          },
    );
    if (state.finalQuality.flaky?.length) {
      run.push({ tone: "warn", text: "最终门禁中有命令重跑后才通过" });
    }
  }
  if (state.finalDecision) {
    run.push({
      tone: state.finalDecision.decision === "ready" ? "good" : "warn",
      text: `最终判定 ${state.finalDecision.decision}：${state.finalDecision.reason}`,
    });
  }
  for (const event of events) {
    if (event.type === "run.advisor.consulted") {
      const payload = event.payload as { trigger: string; recommendation: string; summary: string };
      run.push({
        tone: payload.recommendation === "stop" ? "bad" : "neutral",
        text: `架构顾问（${payload.trigger}）建议 ${payload.recommendation}：${payload.summary}`,
      });
    }
  }
  const stalls = events.filter((event) => event.type === "agent.stalled").length;
  if (stalls > 0) run.push({ tone: "warn", text: `有 ${stalls} 次 Agent 长时间无输出，已自动中断并催促继续` });
  const operator = events.filter((event) =>
    ["agent.steered", "agent.interrupted", "agent.answered", "plan.edited"].includes(event.type),
  ).length;
  if (operator > 0) run.push({ tone: "neutral", text: `操作者介入 ${operator} 次` });

  const selection: FlowSelection | undefined = state.flow;
  return {
    headline: headlineFor(state, tasks),
    ...(selection
      ? { flow: { template: selection.template, source: selection.source, reasons: selection.reasons } }
      : {}),
    run,
    tasks,
  };
}
