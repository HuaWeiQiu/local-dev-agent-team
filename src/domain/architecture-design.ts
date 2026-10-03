import type { ArchitectureDesign, Task, TaskPlan } from "./contracts.js";

const DEPENDS_KINDS = new Set(["depends", "calls"]);

function staticPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*!?{[(]/);
  const prefix = (wildcard === -1 ? pattern : pattern.slice(0, wildcard)).replace(/\/$/, "");
  return prefix;
}

function pathCovered(owned: string, elementPaths: string[]): boolean {
  const ownedPrefix = staticPrefix(owned);
  return elementPaths.some((pattern) => {
    const prefix = staticPrefix(pattern);
    if (!prefix) return true;
    return ownedPrefix === prefix || ownedPrefix.startsWith(`${prefix}/`);
  });
}

function elementIdFor(task: Task, design: ArchitectureDesign): string | undefined {
  if (task.elementId && design.elements.some((element) => element.id === task.elementId)) {
    return task.elementId;
  }
  const matches = design.elements.filter((element) =>
    task.ownedPaths.every((owned) => pathCovered(owned, element.paths)),
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** Why this plan cannot yet be treated as an architect-produced architecture. */
export function designIssues(plan: TaskPlan): string[] {
  const design = plan.design;
  if (!design) {
    return [
      "Architecture design is missing. Return design.elements, relations and sequence, and set each task.elementId.",
    ];
  }
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const element of design.elements) {
    if (ids.has(element.id)) issues.push(`Duplicate architecture element '${element.id}'`);
    ids.add(element.id);
  }
  for (const relation of design.relations) {
    if (!ids.has(relation.from) || !ids.has(relation.to)) {
      issues.push(`Relation ${relation.from} -> ${relation.to} names an unknown element`);
    }
    if (relation.from === relation.to) issues.push(`Element '${relation.from}' cannot relate to itself`);
  }
  for (const step of design.sequence) {
    if (!ids.has(step.from) || !ids.has(step.to)) {
      issues.push(`Sequence step ${step.order} names an unknown element`);
    }
  }

  const resolved = new Map<string, string>();
  for (const task of plan.tasks) {
    const elementId = elementIdFor(task, design);
    if (!elementId) {
      issues.push(`Task '${task.id}' is not covered by exactly one architecture element`);
      continue;
    }
    const element = design.elements.find((item) => item.id === elementId)!;
    if (task.ownedPaths.some((owned) => !pathCovered(owned, element.paths))) {
      issues.push(`Task '${task.id}' owns a path outside element '${elementId}'`);
    }
    resolved.set(task.id, elementId);
  }

  for (const task of plan.tasks) {
    const to = resolved.get(task.id);
    if (!to) continue;
    for (const dependency of task.dependsOn) {
      const from = resolved.get(dependency);
      if (!from || from === to) continue;
      const linked = design.relations.some(
        (relation) => relation.from === from && relation.to === to && DEPENDS_KINDS.has(relation.kind),
      );
      if (!linked) {
        issues.push(
          `Task '${task.id}' depends on '${dependency}', but element '${from}' has no depends/calls relation to '${to}'`,
        );
      }
    }
  }
  return issues;
}

function slug(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned.slice(0, 48) || "module";
}

/**
 * Build a design from the task DAG when the architect did not return a valid
 * one, or when the controller planned without a model. Marked so the UI does
 * not present it as an architect deliverable.
 */
export function synthesizeDesign(plan: TaskPlan, source: "inferred" | "controller"): TaskPlan {
  const groups = new Map<string, { id: string; paths: string[]; tasks: Task[] }>();
  for (const task of plan.tasks) {
    const key = task.ownedPaths[0] ?? task.id;
    const parts = key.replace(/^\.?\//, "").split("/").filter((part) => part && !part.includes("*"));
    const moduleKey = parts.length >= 2 && ["src", "web", "app"].includes(parts[0]!)
      ? parts.slice(0, 2).join("/")
      : (parts[0] ?? task.id);
    const id = slug(moduleKey);
    const group = groups.get(id) ?? { id, paths: [], tasks: [] };
    for (const owned of task.ownedPaths) {
      if (!group.paths.includes(owned)) group.paths.push(owned);
    }
    group.tasks.push(task);
    groups.set(id, group);
  }
  const taskElement = new Map<string, string>();
  for (const group of groups.values()) {
    for (const task of group.tasks) taskElement.set(task.id, group.id);
  }
  const relations: ArchitectureDesign["relations"] = [];
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    const to = taskElement.get(task.id);
    for (const dependency of task.dependsOn) {
      const from = taskElement.get(dependency);
      if (!from || !to || from === to) continue;
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({ from, to, kind: "depends" });
    }
  }
  const design: ArchitectureDesign = {
    summary: plan.summary,
    source,
    elements: [...groups.values()].map((group) => ({
      id: group.id,
      name: group.id,
      kind: "module" as const,
      responsibility: group.tasks.map((task) => task.title).join("；"),
      paths: group.paths,
    })),
    relations,
    sequence: relations.map((relation, index) => ({
      order: index + 1,
      from: relation.from,
      to: relation.to,
      action: "交接",
    })),
  };
  return {
    ...plan,
    design,
    tasks: plan.tasks.map((task) => ({ ...task, elementId: taskElement.get(task.id) ?? null })),
  };
}

/** Keep a valid architect design; otherwise replace it with an inferred one. */
export function resolveDesign(plan: TaskPlan, fallback: "inferred" | "controller"): TaskPlan {
  if (plan.design && designIssues(plan).length === 0) {
    const design = {
      ...plan.design,
      source: plan.design.source === "controller" ? "controller" as const : "architect" as const,
    };
    return {
      ...plan,
      design,
      tasks: plan.tasks.map((task) => {
        const elementId = elementIdFor(task, design);
        return elementId && task.elementId !== elementId ? { ...task, elementId } : task;
      }),
    };
  }
  return synthesizeDesign(plan, fallback);
}
