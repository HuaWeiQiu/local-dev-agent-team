import type { RunStatus, TaskStatus } from "./types";

const runLabels: Record<RunStatus, string> = {
  created: "已创建",
  orchestrating: "目标分析",
  architecting: "任务规划",
  planned: "已规划",
  implementing: "执行中",
  "reviewing-testing": "审查测试",
  reworking: "返工中",
  integrating: "集成中",
  "final-checks": "最终检查",
  "awaiting-human": "等待确认",
  publishing: "发布中",
  "waiting-ci": "等待 CI",
  "ci-failed": "CI 失败",
  repairing: "修复中",
  "ready-to-merge": "可合并",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "已中断",
  blocked: "已阻塞",
};

const taskLabels: Record<TaskStatus, string> = {
  pending: "等待",
  working: "执行",
  reworking: "返工",
  passed: "通过",
  merged: "已合并",
  blocked: "阻塞",
};

export function runStatusLabel(status: RunStatus): string {
  return runLabels[status];
}

export function taskStatusLabel(status: TaskStatus): string {
  return taskLabels[status];
}

export function statusTone(status: RunStatus | TaskStatus): string {
  if (["completed", "ready-to-merge", "awaiting-human", "passed", "merged"].includes(status)) {
    return "success";
  }
  if (["blocked", "ci-failed"].includes(status)) {
    return "danger";
  }
  if (["cancelled", "interrupted"].includes(status)) {
    return "neutral";
  }
  if (["reworking", "reviewing-testing", "final-checks"].includes(status)) {
    return "warning";
  }
  return "active";
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortRunId(runId: string): string {
  return runId.length > 20 ? `${runId.slice(0, 12)}…${runId.slice(-5)}` : runId;
}
