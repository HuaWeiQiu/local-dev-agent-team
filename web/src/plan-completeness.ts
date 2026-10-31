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

const NAMED_ID_PATTERN = /\b(?:T\d+|P\d+[.-]\d+)\b/gi;
const RANGE_PATTERN = /\bT(\d+)\s*[-–—]\s*T?(\d+)\b/gi;
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
  if (task.evidenceKind === "host-evidence") return "host-evidence";
  if (task.evidenceKind === "commands") return commandsKind(task);
  return inferredKind(task);
}

/** A task that promises commands is docs only when everything it owns is docs. */
function commandsKind(task: Pick<Task, "id" | "title" | "ownedPaths" | "evidenceKind">): TaskKind {
  const allDocs = ownsOnlyDocs(task);
  if (allDocs && task.ownedPaths.length > 0) return "docs";
  if (DOCS_PATTERN.test(`${task.id} ${task.title}`) && allDocs) return "docs";
  return "implement";
}

/** Without an explicit evidence kind the wording and paths decide. */
function inferredKind(task: Pick<Task, "id" | "title" | "description" | "ownedPaths">): TaskKind {
  if (RECON_PATTERN.test(`${task.id} ${task.title}`) || RECON_PATTERN.test(task.description)) {
    return "recon";
  }
  if (ownsOnlyDocs(task) && task.ownedPaths.length > 0) return "docs";
  const text = `${task.id} ${task.title} ${task.description}`;
  if (DOCS_PATTERN.test(text) && task.ownedPaths.every(isDocPathOrMarkdown)) return "docs";
  return "implement";
}

function ownsOnlyDocs(task: Pick<Task, "ownedPaths">): boolean {
  return task.ownedPaths.every((item) => isDocPath(item));
}

function isDocPathOrMarkdown(item: string): boolean {
  return isDocPath(item) || item.endsWith(".md");
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
  const coveredDeliverables = coveredIn(plan.tasks, namedDeliverables);
  const missing = namedDeliverables.filter((id) => !coveredDeliverables.includes(id));
  const kinds = plan.tasks.map((task) => ({ task, kind: taskKind(task) }));
  const recon = kinds.filter((item) => item.kind === "recon");
  const rejected = rejections(kinds, recon, missing, namedDeliverables);
  const issues = advisories(recon, namedDeliverables, plan.tasks.length);
  return {
    status: statusOf(rejected, issues),
    issues: [...rejected, ...issues],
    namedDeliverables,
    coveredDeliverables,
    reconTaskIds: recon.map((item) => item.task.id),
  };
}

function coveredIn(tasks: Task[], named: string[]): string[] {
  return named.filter((id) => tasks.some((task) => taskCoversDeliverable(task, id)));
}

type Kinded = { task: Task; kind: TaskKind };

/** Hard failures: the plan never reaches the scheduler. */
function rejections(
  kinds: Kinded[],
  recon: Kinded[],
  missing: string[],
  named: string[],
): string[] {
  return [
    ...missingDeliverables(missing),
    ...reconRules(recon, named, kinds.length),
    ...implementRules(kinds, named),
  ];
}

function missingDeliverables(missing: string[]): string[] {
  return missing.length > 0 ? [`缺 ${missing.join(" / ")}`] : [];
}

function reconRules(recon: Kinded[], named: string[], total: number): string[] {
  const tooMany = recon.length > 1 ? [`只读侦察超过 1 条（${recon.map((item) => item.task.id).join(", ")}）`] : [];
  const onlyRecon = recon.length === total && named.length > 0 ? ["唯一任务是只读侦察"] : [];
  const withCommands = recon
    .filter((item) => item.task.acceptanceCommands.length > 0)
    .map((item) => `只读任务 ${item.task.id} 禁止 acceptanceCommands`);
  return [...tooMany, ...onlyRecon, ...withCommands];
}

/** An implementation task must say how it will be proven. */
function implementRules(kinds: Kinded[], named: string[]): string[] {
  if (named.length === 0) return [];
  return kinds
    .filter((item) => item.kind === "implement" && !hasProof(item.task))
    .map((item) => `实现任务 ${item.task.id} 需要验收命令、owned path 或标成 host-evidence`);
}

function hasProof(task: Task): boolean {
  if (task.acceptanceCommands.length > 0) return true;
  if (task.evidenceKind === "host-evidence") return true;
  return task.ownedPaths.length > 0;
}

/** Soft findings: the plan may run, but it is not complete. */
function advisories(recon: Kinded[], named: string[], total: number): string[] {
  if (recon.length === total && named.length === 0 && total === 1) return ["唯一任务是只读侦察"];
  if (recon.length === 1 && total > 1) return [`含只读侦察 ${recon[0]!.task.id}`];
  return [];
}

function statusOf(rejected: string[], issues: string[]): PlanCompletenessStatus {
  if (rejected.length > 0) return "rejected";
  return issues.length > 0 ? "incomplete" : "complete";
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
  if (task.status === "working") return workingPhase(task, runStatus);
  return SETTLED_PHASE[task.status];
}

const SETTLED_PHASE: Partial<Record<TaskRunState["status"], string>> = {
  reworking: "返工",
  blocked: "阻塞",
  passed: "已通过",
  merged: "已合并",
};

/** While a task works, the run status and the artefacts say what it is doing. */
function workingPhase(task: TaskRunState, runStatus: RunState["status"]): string {
  if (runStatus === "reviewing-testing" || task.review || task.test) return "审查 / 测试";
  return task.quality ? "质量门" : "工作中";
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
  const priority = raw.match(/^P(\d+)[.-](\d+)$/i);
  if (priority) {
    return `P${priority[1]}.${priority[2]}`;
  }
  return raw.toUpperCase();
}

type DeliverableParts = [prefix: string, major: string, minor: string | undefined];

function splitDeliverable(id: string): DeliverableParts | undefined {
  const match = id.match(/^([TP])(\d+)(?:\.(\d+))?$/);
  if (!match) return undefined;
  return [match[1]!, match[2]!, match[3]];
}

function compareDeliverableIds(left: string, right: string): number {
  const leftParts = splitDeliverable(left);
  const rightParts = splitDeliverable(right);
  if (!leftParts || !rightParts) return left.localeCompare(right);
  return compareParts(leftParts, rightParts);
}

function compareParts(left: DeliverableParts, right: DeliverableParts): number {
  const byPrefix = left[0].localeCompare(right[0]);
  if (byPrefix !== 0) return byPrefix;
  const byMajor = Number(left[1]) - Number(right[1]);
  if (byMajor !== 0) return byMajor;
  return Number(left[2] ?? 0) - Number(right[2] ?? 0);
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
