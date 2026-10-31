import type {
  ExplainLine,
  ReplayStep,
  RunExplanation,
  RunUsageBreakdown,
  TaskDiff,
  Transcript,
  TranscriptSummary,
  UsageLine,
} from "../types";
import type { DemoRun } from "./seed";

function line(invocations: number, failures = 0): UsageLine {
  return {
    invocations,
    failures,
    durationMs: invocations * 42_000,
    inputTokens: invocations * 18_400,
    cachedInputTokens: invocations * 6_000,
    outputTokens: invocations * 2_300,
    costUsd: invocations * 0.21,
    costReported: true,
  };
}

export function demoExplanation(run: DemoRun): RunExplanation {
  const { state } = run;
  const merged = state.tasks.filter((task) => task.status === "merged" || task.status === "passed").length;
  const blocked = state.tasks.find((task) => task.status === "blocked");
  const headline: ExplainLine = blocked
    ? { tone: "bad", text: `已阻塞：任务 ${blocked.task.id} ${blocked.error ?? "未通过门禁"}` }
    : state.status === "completed"
      ? { tone: "good", text: `已完成：${merged}/${state.tasks.length} 个任务已合并` }
      : { tone: "neutral", text: `进行中：${state.status}（${merged}/${state.tasks.length} 个任务已合并）` };
  return {
    headline,
    flow: { template: "standard", source: "router", reasons: ["多个交付物，需要独立评审"] },
    run: state.finalQuality
      ? [{ tone: state.finalQuality.passed ? "good" : "bad", text: state.finalQuality.passed ? "最终集成质量门禁通过" : "最终集成质量门禁失败" }]
      : [],
    tasks: state.tasks.map((task) => ({
      taskId: task.task.id,
      title: task.task.title,
      status: task.status,
      tone: task.status === "merged" || task.status === "passed" ? "good" : task.status === "blocked" ? "bad" : "neutral",
      summary: task.status === "blocked" ? (task.error ?? "任务被阻塞") : task.attempts > 1 ? `经过 ${task.attempts} 次尝试后通过全部门禁` : "一次通过全部门禁",
      lines: [
        ...(task.quality ? [{ tone: task.quality.passed ? ("good" as const) : ("bad" as const), text: task.quality.passed ? `质量门禁通过（${task.quality.commands.length} 条命令）` : "质量命令失败" }] : []),
        ...(task.review ? [{ tone: task.review.verdict === "approve" ? ("good" as const) : ("warn" as const), text: `评审 ${task.review.verdict}：${task.review.summary}` }] : []),
      ],
    })),
  };
}

export function demoUsageBreakdown(run: DemoRun): RunUsageBreakdown {
  const tasks = run.state.tasks.map((task) => ({ taskId: task.task.id, ...line(Math.max(1, task.attempts) * 2, task.attempts > 1 ? 1 : 0) }));
  return {
    total: line(tasks.reduce((sum, item) => sum + item.invocations, 0) + 3),
    byRole: [
      { role: "worker", ...line(tasks.length * 2) },
      { role: "reviewer", ...line(tasks.length) },
      { role: "architect", ...line(1) },
    ],
    byTask: tasks,
    byProfile: [{ profile: "codex-worker", model: "gpt-5", ...line(tasks.length * 2) }],
    unattributed: line(3),
  };
}

export function demoReplay(run: DemoRun): ReplayStep[] {
  const steps = run.state.history.map((entry): Omit<ReplayStep, "offsetMs"> => ({
    at: entry.at,
    kind: "status",
    tone: entry.status === "blocked" ? "bad" : entry.status === "completed" ? "good" : "neutral",
    title: entry.message,
  }));
  const origin = steps.length > 0 ? Date.parse(steps[0]!.at) : 0;
  return steps.map((step) => ({ ...step, offsetMs: Math.max(0, Date.parse(step.at) - origin) }));
}

export function demoTranscripts(run: DemoRun): TranscriptSummary[] {
  return run.state.tasks
    .filter((task) => task.attempts > 0)
    .map((task) => ({
      id: `tasks/${task.task.id}/attempt-1/worker/codex-worker`,
      artifactKey: `tasks/${task.task.id}/attempt-1/worker`,
      profile: "codex-worker",
      role: "worker",
      taskId: task.task.id,
      live: true,
      success: true,
      durationMs: 64_000,
      bytes: 4_200,
    }));
}

export function demoTranscript(id: string): Transcript {
  const at = new Date().toISOString();
  return {
    id,
    truncated: false,
    entries: [
      { kind: "turn", at, text: "turn started" },
      { kind: "message", at, text: "先阅读现有导出模块，再补充测试。" },
      { kind: "tool", at, label: "shell", status: "completed", text: "pnpm exec vitest run src/export/csv.test.ts" },
      { kind: "operator", at, label: "steer", text: "lead: 请保持向后兼容" },
      { kind: "message", at, text: "已完成：转义逗号、引号与换行，并补充了边界测试。" },
      { kind: "turn", at, status: "completed", text: "turn completed" },
    ],
  };
}

export function demoTaskDiff(run: DemoRun, taskId: string): TaskDiff {
  const task = run.state.tasks.find((item) => item.task.id === taskId);
  if (!task || !run.diff) {
    return { taskId, available: false, changedFiles: [], truncated: false, detail: "任务尚未产生可查看的改动" };
  }
  return { taskId, available: true, source: "commit", changedFiles: run.changedFiles, content: run.diff, truncated: false };
}
