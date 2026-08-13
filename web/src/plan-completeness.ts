import type { RunState, Task, TaskRunState } from "./types";

export type PlanCompletenessStatus = "complete" | "incomplete" | "rejected";
export type TaskKind = "implement" | "docs" | "host-evidence" | "recon";

export interface PlanCompletenessReport {
  status: PlanCompletenessStatus;
  issues: string[];
  namedDeliverables: string[];
  coveredDeliverables: string[];
  reconTaskIds: string[];
}

const NAMED_ID_PATTERN = /\b(?:T\d+|P\d+[.\-]\d+)\b/gi;
const RANGE_PATTERN = /\bT(\d+)\s*[-–—]\s*T?(\d+)\b/gi;
const VAGUE_HANDOVER_PATTERN = /交接文档|HANDOFF\.zh-CN|根据交接|根据文档执行/i;
const RECON_PATTERN =
  /\binspect\b|(?<![-/])read-only(?!\s+(?:reviewer|tester|review|test)\b)|read only(?!\s+(?:reviewer|tester|review|test)\b)|read handover|只读侦察|只读任务|侦察/i;
const DOCS_PATTERN = /\bdocs?\b|文档|readme|changelog/i;

export function namedDeliverablesInGoal(goal: string): string[] {
  const ids = new Set<string>();
  for (const match of goal.matchAll(RANGE_PATTERN)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 20) {
      continue;
    }
    for (let index = start; index <= end; index += 1) {
      ids.add(`T${index}`);
    }
  }
  for (const match of goal.matchAll(NAMED_ID_PATTERN)) {
    ids.add(normalizeDeliverableId(match[0]!));
  }
  return [...ids].sort(compareDeliverableIds);
}

export function taskKind(task: Pick<Task, "id" | "title" | "description" | "ownedPaths" | "evidenceKind">): TaskKind {
  if (task.evidenceKind === "host-evidence") {
    return "host-evidence";
  }
  if (task.evidenceKind === "commands") {
    const pathText = task.ownedPaths.join(" ");
    if (task.ownedPaths.length > 0 && task.ownedPaths.every((item) => isDocPath(item))) {
      return "docs";
    }
    if (DOCS_PATTERN.test(`${task.id} ${task.title}`) && isDocPath(pathText)) {
      return "docs";
    }
    return "implement";
  }
  const text = `${task.id} ${task.title} ${task.description}`;
  if (RECON_PATTERN.test(`${task.id} ${task.title}`) || RECON_PATTERN.test(task.description)) {
    return "recon";
  }
  if (task.ownedPaths.length > 0 && task.ownedPaths.every((item) => isDocPath(item))) {
    return "docs";
  }
  if (DOCS_PATTERN.test(text) && task.ownedPaths.every((item) => isDocPath(item) || item.endsWith(".md"))) {
    return "docs";
  }
  return "implement";
}

export function taskKindLabel(kind: TaskKind): string {
  return {
    implement: "实现",
    docs: "文档",
    "host-evidence": "实机证据",
    recon: "只读侦察",
  }[kind];
}

export function assessPlanCompleteness(plan: { tasks: Task[] }, goal: string): PlanCompletenessReport {
  const namedDeliverables = namedDeliverablesInGoal(goal);
  const coveredDeliverables = namedDeliverables.filter((id) =>
    plan.tasks.some((task) => taskCoversDeliverable(task, id)),
  );
  const missing = namedDeliverables.filter((id) => !coveredDeliverables.includes(id));
  const kinds = plan.tasks.map((task) => ({ task, kind: taskKind(task) }));
  const recon = kinds.filter((item) => item.kind === "recon");
  const issues: string[] = [];
  const rejected: string[] = [];

  if (missing.length > 0) {
    rejected.push(`缺 ${missing.join(" / ")}`);
  }
  if (recon.length > 1) {
    rejected.push(`只读侦察超过 1 条（${recon.map((item) => item.task.id).join(", ")}）`);
  }
  if (recon.length === plan.tasks.length && namedDeliverables.length > 0) {
    rejected.push("唯一任务是只读侦察");
  }
  for (const item of recon) {
    if (item.task.acceptanceCommands.length > 0) {
      rejected.push(`只读任务 ${item.task.id} 禁止 acceptanceCommands`);
    }
  }
  if (namedDeliverables.length > 0) {
    for (const item of kinds) {
      if (item.kind !== "implement") {
        continue;
      }
      if (
        item.task.acceptanceCommands.length === 0
        && item.task.evidenceKind !== "host-evidence"
        && item.task.ownedPaths.length === 0
      ) {
        rejected.push(`实现任务 ${item.task.id} 需要验收命令、owned path 或标成 host-evidence`);
      }
    }
  }
  if (recon.length === plan.tasks.length && namedDeliverables.length === 0 && plan.tasks.length === 1) {
    issues.push("唯一任务是只读侦察");
  } else if (recon.length === 1 && plan.tasks.length > 1) {
    issues.push(`含只读侦察 ${recon[0]!.task.id}`);
  }

  const status: PlanCompletenessStatus =
    rejected.length > 0 ? "rejected" : issues.length > 0 ? "incomplete" : "complete";
  return {
    status,
    issues: [...rejected, ...issues],
    namedDeliverables,
    coveredDeliverables,
    reconTaskIds: recon.map((item) => item.task.id),
  };
}

export function planCompletenessForRun(run: Pick<RunState, "goal" | "plan" | "tasks" | "error">): PlanCompletenessReport | undefined {
  const plan = run.plan ?? (run.tasks.length > 0
    ? { summary: "", tasks: run.tasks.map((item) => item.task) }
    : undefined);
  if (!plan) {
    return undefined;
  }
  const report = assessPlanCompleteness(plan, run.goal);
  if (run.error?.includes("Plan completeness rejected") && report.status !== "rejected") {
    return { ...report, status: "rejected", issues: [run.error, ...report.issues] };
  }
  return report;
}

export function completenessBarCopy(report: PlanCompletenessReport): { tone: "success" | "warning" | "danger"; title: string } {
  if (report.status === "complete") {
    return { tone: "success", title: "计划完备" };
  }
  if (report.status === "incomplete") {
    return { tone: "warning", title: "计划可调度但不完备" };
  }
  return { tone: "danger", title: "计划不完备，已打回" };
}

export function taskPhaseLabel(task: TaskRunState, runStatus: RunState["status"]): string | undefined {
  if (task.status === "working") {
    if (runStatus === "reviewing-testing" || task.review || task.test) return "审查 / 测试";
    if (task.quality) return "质量门";
    return "工作中";
  }
  if (task.status === "reworking") return "返工";
  if (task.status === "blocked") return "阻塞";
  if (task.status === "passed") return "已通过";
  if (task.status === "merged") return "已合并";
  if (task.quality && !task.review && !task.test) return "质量门";
  if (task.review || task.test) return "审查 / 测试";
  return undefined;
}

export function acceptanceSummary(task: Task): string {
  if (task.evidenceKind === "host-evidence") {
    return task.acceptanceCommands.length > 0
      ? task.acceptanceCommands.map((command) => [command.command, ...command.args].join(" ")).join(" · ")
      : "实机 · 未验证";
  }
  if (task.acceptanceCommands.length === 0) {
    return "无独立验收";
  }
  return task.acceptanceCommands
    .map((command) => [command.command, ...command.args].join(" "))
    .join(" · ");
}

function taskCoversDeliverable(
  task: Pick<Task, "id" | "title" | "description">,
  namedId: string,
): boolean {
  const haystack = `${task.id} ${task.title} ${task.description}`;
  const variants = [namedId, namedId.replace(".", "-"), namedId.replace(".", ""), namedId.toLowerCase()];
  return variants.some((variant) => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(variant)}(?:$|[^A-Za-z0-9])`, "i").test(haystack));
}

function normalizeDeliverableId(raw: string): string {
  const match = raw.match(/^T(\d+)$/i);
  if (match) {
    return `T${match[1]}`;
  }
  const priority = raw.match(/^P(\d+)[.\-](\d+)$/i);
  if (priority) {
    return `P${priority[1]}.${priority[2]}`;
  }
  return raw.toUpperCase();
}

function compareDeliverableIds(left: string, right: string): number {
  const leftParts = left.match(/^([TP])(\d+)(?:\.(\d+))?$/);
  const rightParts = right.match(/^([TP])(\d+)(?:\.(\d+))?$/);
  if (leftParts && rightParts) {
    if (leftParts[1] !== rightParts[1]) {
      return leftParts[1]!.localeCompare(rightParts[1]!);
    }
    const major = Number(leftParts[2]) - Number(rightParts[2]);
    if (major !== 0) {
      return major;
    }
    return Number(leftParts[3] ?? 0) - Number(rightParts[3] ?? 0);
  }
  return left.localeCompare(right);
}

function isDocPath(pattern: string): boolean {
  return (
    /(^|\/)docs(\/|$)/i.test(pattern)
    || /\.md$/i.test(pattern)
    || /(^|\/)README/i.test(pattern)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
