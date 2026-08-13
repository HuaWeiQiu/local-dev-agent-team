import { existsSync } from "node:fs";
import path from "node:path";
import type { Task, TaskPlan } from "./contracts.js";

export type PlanCompletenessStatus = "complete" | "incomplete" | "rejected";
export type TaskKind = "implement" | "docs" | "host-evidence" | "recon";

export interface PlanCompletenessReport {
  status: PlanCompletenessStatus;
  issues: string[];
  namedDeliverables: string[];
  coveredDeliverables: string[];
  reconTaskIds: string[];
}

export function validateTaskPlan(plan: TaskPlan): void {
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id '${task.id}'`);
    }
    ids.add(task.id);
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task '${task.id}' depends on unknown task '${dependency}'`);
      }
      if (dependency === task.id) {
        throw new Error(`Task '${task.id}' cannot depend on itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`Task plan contains a dependency cycle at '${id}'`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of plan.tasks) {
    visit(task.id);
  }
}

function staticPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*!?{[(]/);
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  return prefix.replace(/\/$/, "");
}

export function pathsMayOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPattern) =>
    right.some((rightPattern) => {
      const leftPrefix = staticPrefix(leftPattern);
      const rightPrefix = staticPrefix(rightPattern);
      if (!leftPrefix || !rightPrefix) {
        return true;
      }
      return (
        leftPrefix === rightPrefix ||
        leftPrefix.startsWith(`${rightPrefix}/`) ||
        rightPrefix.startsWith(`${leftPrefix}/`)
      );
    }),
  );
}

/**
 * Select a dependency-ready worker wave.
 * Prefers packing tasks that share the same batchKey (swarm affinity), then by id.
 */
export function selectTaskWave(
  plan: TaskPlan,
  completed: Set<string>,
  started: Set<string>,
  maxParallel: number,
): TaskPlan["tasks"] {
  const ready = plan.tasks
    .filter(
      (task) =>
        !started.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)),
    )
    .sort((left, right) => {
      const leftKey = left.batchKey ?? "";
      const rightKey = right.batchKey ?? "";
      // Non-empty batch keys first, grouped together, then id.
      if (leftKey && !rightKey) return -1;
      if (!leftKey && rightKey) return 1;
      if (leftKey !== rightKey) return leftKey.localeCompare(rightKey);
      return left.id.localeCompare(right.id);
    });

  const wave: TaskPlan["tasks"] = [];
  let preferredBatch: string | undefined;

  for (const candidate of ready) {
    if (wave.length >= maxParallel) {
      break;
    }
    const candidateBatch = candidate.batchKey ?? undefined;
    if (
      preferredBatch !== undefined
      && candidateBatch !== undefined
      && candidateBatch !== preferredBatch
      && wave.length > 0
    ) {
      // Prefer finishing one batch wave before mixing another keyed batch.
      // Still allow unkeyed tasks after a keyed seed.
      continue;
    }
    if (wave.every((selected) => !pathsMayOverlap(selected.ownedPaths, candidate.ownedPaths))) {
      wave.push(candidate);
      if (preferredBatch === undefined && candidateBatch) {
        preferredBatch = candidateBatch;
      }
    }
  }

  // Second pass: fill remaining slots with any non-overlapping ready tasks (including other batches).
  if (wave.length < maxParallel) {
    for (const candidate of ready) {
      if (wave.length >= maxParallel) break;
      if (wave.some((selected) => selected.id === candidate.id)) continue;
      if (wave.every((selected) => !pathsMayOverlap(selected.ownedPaths, candidate.ownedPaths))) {
        wave.push(candidate);
      }
    }
  }

  if (wave.length === 0 && ready.length > 0) {
    return [ready[0]!];
  }
  return wave;
}

const NAMED_ID_PATTERN = /\b(?:T\d+|P\d+[.\-]\d+)\b/gi;
const RANGE_PATTERN = /\bT(\d+)\s*[-–—]\s*T?(\d+)\b/gi;
const VAGUE_HANDOVER_PATTERN = /交接文档|HANDOFF\.zh-CN|根据交接|根据文档执行/i;
const IMPLIED_HANDOVER_DELIVERABLES = ["T1", "T2", "T3", "T4"] as const;
const HANDOVER_MARKER_PATHS = [
  "docs/HANDOFF.zh-CN.md",
  "docs/HANDOFF.md",
  "apps/photoshop-uxp",
] as const;
const RECON_PATTERN =
  /\binspect\b|(?<![-/])read-only(?!\s+(?:reviewer|tester|review|test)\b)|read only(?!\s+(?:reviewer|tester|review|test)\b)|read handover|只读侦察|只读任务|侦察/i;
const DOCS_PATTERN = /\bdocs?\b|文档|readme|changelog/i;

export function looksLikeHandoverGoal(goal: string): boolean {
  return VAGUE_HANDOVER_PATTERN.test(goal);
}

export function repositoryLooksLikeHandoverProject(root: string): boolean {
  return HANDOVER_MARKER_PATHS.some((relative) => existsSync(path.join(root, relative)));
}

export function canUseHandoverFallback(goal: string, root?: string): boolean {
  if (!looksLikeHandoverGoal(goal) || root === undefined) {
    return false;
  }
  return repositoryLooksLikeHandoverProject(root);
}

export function extractNamedDeliverables(goal: string, options?: { allowImpliedHandover?: boolean }): string[] {
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
  if (ids.size === 0 && options?.allowImpliedHandover !== false && looksLikeHandoverGoal(goal)) {
    return [...IMPLIED_HANDOVER_DELIVERABLES];
  }
  return [...ids].sort(compareDeliverableIds);
}

const NAMED_TASK_LINE = /\b(T\d+)\b[^\n]{0,200}?\b((?:src|test|docs|apps|packages)\/[\w./-]+\.[\w]+|CHANGELOG\.md|README\.md|PROJECT_STATE\.md)/gi;

export function fallbackNamedTaskPlan(goal: string): TaskPlan | undefined {
  const named = extractNamedDeliverables(goal);
  if (named.length < 2) {
    return undefined;
  }
  const owned = new Map<string, string>();
  for (const match of goal.matchAll(NAMED_TASK_LINE)) {
    const id = normalizeDeliverableId(match[1]!);
    const file = match[2]!;
    if (!owned.has(id)) {
      owned.set(id, file);
    }
  }
  if (named.some((id) => !owned.has(id))) {
    return undefined;
  }
  return {
    summary: `Deterministic DAG from the goal: ${named.join(", ")}.`,
    tasks: named.map((id, index) => {
      const pathName = owned.get(id)!;
      const isDoc = isDocPath(pathName) || /\.md$/i.test(pathName);
      return {
        id,
        title: isDoc ? `Write ${pathName}` : `Add ${pathName}`,
        description: `Implement ${id} at ${pathName} exactly as specified in the goal.`,
        dependsOn: index > 0 && named[index - 1] && !isDoc ? [named[index - 1]!] : [],
        ownedPaths: [pathName],
        // Project quality.commands remain the real gate. Do not invent extra
        // acceptanceCommands here.
        acceptanceCommands: [],
        profile: null,
        evidenceKind: "commands",
      };
    }),
  };
}

export function fallbackHandoverTaskPlan(): TaskPlan {
  return {
    summary:
      "HANDOFF §10 P0 fallback DAG: T1 source integrity, T2 cancel cleanup, T3 host-evidence runbook, T4 fact sync.",
    tasks: [
      {
        id: "T1",
        title: "Add source-layer integrity verification",
        description:
          "Add Imaging API source-layer SHA-256 plus parent/bounds/visibility/opacity/blend/locks checks under apps/photoshop-uxp/src/host/ and matching tests. If the host is unavailable, keep unverified and never invent hashes.",
        dependsOn: [],
        ownedPaths: [
          "apps/photoshop-uxp/src/host/",
          "apps/photoshop-uxp/tests/",
        ],
        acceptanceCommands: [{ command: "pnpm", args: ["--filter", "photoshop-uxp", "test"] }],
        profile: null,
        evidenceKind: "commands",
      },
      {
        id: "T2",
        title: "Add cancel and failure cleanup",
        description:
          "Add cancel/failure cleanup so no leftover CineVFX result group remains after group create, first duplicate, blur, or user cancel. Node tests cover orchestration only; real host cancel stays unverified.",
        dependsOn: ["T1"],
        ownedPaths: [
          "apps/photoshop-uxp/src/effects/",
          "apps/photoshop-uxp/src/ui/",
        ],
        acceptanceCommands: [{ command: "pnpm", args: ["--filter", "photoshop-uxp", "test"] }],
        profile: null,
        evidenceKind: "commands",
      },
      {
        id: "T3",
        title: "Write the Photoshop host-evidence runbook",
        description:
          "Write a host-evidence runbook for Windows Photoshop, transparent pixel layer, smart object, UDT load, and 4K/8K timing. Do not claim those host checks passed.",
        dependsOn: [],
        ownedPaths: ["docs/runbooks/"],
        acceptanceCommands: [],
        profile: null,
        evidenceKind: "host-evidence",
      },
      {
        id: "T4",
        title: "Write synchronized P0 handoff facts",
        description:
          "Sync handoff facts in docs/HANDOFF.zh-CN.md and PROJECT_STATE.md only. Do not set photoshopRuntimeVerified to true. Do not treat Node tests as Photoshop host evidence.",
        dependsOn: ["T1", "T2", "T3"],
        ownedPaths: ["docs/HANDOFF.zh-CN.md", "PROJECT_STATE.md"],
        acceptanceCommands: [{ command: "node", args: ["--test", "tests/bootstrap.test.mjs"] }],
        profile: null,
        evidenceKind: "commands",
      },
    ],
  };
}

export function expandPlanningGoal(goal: string, root?: string): string {
  if (!canUseHandoverFallback(goal, root) || NAMED_ID_PATTERN.test(goal)) {
    return goal;
  }
  return [
    goal.trim(),
    "",
    "Implied P0 deliverables from docs/HANDOFF.zh-CN.md §10. Cover each as its own task:",
    "T1 Add Imaging API source-layer SHA-256 plus parent/bounds/visibility/opacity/blend/locks checks under apps/photoshop-uxp/src/host/ and matching tests. Acceptance: pnpm --filter photoshop-uxp test. If the host is unavailable, keep unverified and never invent hashes.",
    "T2 Add cancel/failure cleanup so no leftover CineVFX result group remains after group create, first duplicate, blur, or user cancel. Paths: apps/photoshop-uxp/src/ and tests. Acceptance: pnpm --filter photoshop-uxp test. Node tests cover orchestration only; real host cancel stays unverified.",
    "T3 Write a host-evidence runbook for Windows Photoshop, transparent pixel layer, smart object, UDT load, and 4K/8K timing. Path: docs/runbooks/. evidenceKind: host-evidence. Do not claim those host checks passed.",
    "T4 Sync handoff facts in docs/HANDOFF.zh-CN.md and PROJECT_STATE.md only. Do not set photoshopRuntimeVerified to true. Do not treat Node tests as Photoshop host evidence.",
    "Do not emit a reconnaissance-only plan. Do not implement P1/P2.",
  ].join("\n");
}

export function classifyTaskKind(task: Pick<Task, "id" | "title" | "description" | "ownedPaths" | "evidenceKind">): TaskKind {
  if (task.evidenceKind === "host-evidence") {
    return "host-evidence";
  }
  // Structured implement/docs packets are never reconnaissance, even if the
  // description mentions a later read-only reviewer or tester.
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

export function taskUsesProjectQualityGates(task: Task): boolean {
  const kind = classifyTaskKind(task);
  return kind === "implement";
}

export function assessPlanCompleteness(
  plan: TaskPlan,
  goal: string,
  options?: { allowImpliedHandover?: boolean },
): PlanCompletenessReport {
  const namedDeliverables = extractNamedDeliverables(goal, options);
  const coveredDeliverables = namedDeliverables.filter((id) =>
    plan.tasks.some((task) => taskCoversDeliverable(task, id)),
  );
  const missing = namedDeliverables.filter((id) => !coveredDeliverables.includes(id));
  const kinds = plan.tasks.map((task) => ({ task, kind: classifyTaskKind(task) }));
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

export function formatPlanCompletenessError(report: PlanCompletenessReport): string {
  return `Plan completeness rejected: ${report.issues.join("；")}`;
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
