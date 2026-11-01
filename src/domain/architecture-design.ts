import type { ArchitectureDesign, ArchitectureElement, Task, TaskPlan } from "./contracts.js";
import { deepestDirectory, type RepoTree } from "./repo-tree.js";

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

const MISSING_DESIGN_ISSUE =
  "Architecture design is missing. Return design.elements, relations and sequence, and set each task.elementId.";

type Relation = ArchitectureDesign["relations"][number];
type SequenceStep = ArchitectureDesign["sequence"][number];

/** A task→element binding for the whole plan, plus the problems found while binding. */
interface ElementBindings {
  resolved: Map<string, string>;
  issues: string[];
}

/** Why this plan cannot yet be treated as an architect-produced architecture. */
export function designIssues(plan: TaskPlan): string[] {
  const design = plan.design;
  if (!design) return [MISSING_DESIGN_ISSUE];
  const ids = elementIds(design);
  const bindings = bindTaskElements(plan, design);
  return [
    ...duplicateElementIssues(design),
    ...relationIssues(design, ids),
    ...sequenceIssues(design, ids),
    ...bindings.issues,
    ...dependencyIssues(plan, design, bindings.resolved),
  ];
}

/** Every element id a relation or sequence step may refer to. */
function elementIds(design: ArchitectureDesign): Set<string> {
  return new Set(design.elements.map((element) => element.id));
}

function duplicateElementIssues(design: ArchitectureDesign): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const element of design.elements) {
    if (seen.has(element.id)) issues.push(`Duplicate architecture element '${element.id}'`);
    seen.add(element.id);
  }
  return issues;
}

function relationIssues(design: ArchitectureDesign, ids: Set<string>): string[] {
  return design.relations.flatMap((relation) => relationIssueList(relation, ids));
}

/** Both relation rules, in the order they were always reported. */
function relationIssueList(relation: Relation, ids: Set<string>): string[] {
  const issues: string[] = [];
  if (!namesOnlyKnownElements(relation, ids)) {
    issues.push(`Relation ${relation.from} -> ${relation.to} names an unknown element`);
  }
  if (relation.from === relation.to) {
    issues.push(`Element '${relation.from}' cannot relate to itself`);
  }
  return issues;
}

function namesOnlyKnownElements(endpoints: { from: string; to: string }, ids: Set<string>): boolean {
  return ids.has(endpoints.from) && ids.has(endpoints.to);
}

function sequenceIssues(design: ArchitectureDesign, ids: Set<string>): string[] {
  return design.sequence.flatMap((step) => sequenceIssueList(step, ids));
}

function sequenceIssueList(step: SequenceStep, ids: Set<string>): string[] {
  if (namesOnlyKnownElements(step, ids)) return [];
  return [`Sequence step ${step.order} names an unknown element`];
}

/** Resolve each task to exactly one element and record where that fails. */
function bindTaskElements(plan: TaskPlan, design: ArchitectureDesign): ElementBindings {
  const resolved = new Map<string, string>();
  const issues: string[] = [];
  for (const task of plan.tasks) {
    const elementId = elementIdFor(task, design);
    const issue = placementIssue(task, design, elementId);
    if (issue) issues.push(issue);
    if (elementId) resolved.set(task.id, elementId);
  }
  return { resolved, issues };
}

function placementIssue(
  task: Task,
  design: ArchitectureDesign,
  elementId: string | undefined,
): string | undefined {
  if (!elementId) return `Task '${task.id}' is not covered by exactly one architecture element`;
  const element = design.elements.find((item) => item.id === elementId)!;
  if (ownsPathOutsideElement(task, element)) {
    return `Task '${task.id}' owns a path outside element '${elementId}'`;
  }
  return undefined;
}

function ownsPathOutsideElement(task: Task, element: ArchitectureElement): boolean {
  return task.ownedPaths.some((owned) => !pathCovered(owned, element.paths));
}

/** Every task dependency whose two elements are not joined by a depends/calls relation. */
function dependencyIssues(
  plan: TaskPlan,
  design: ArchitectureDesign,
  resolved: Map<string, string>,
): string[] {
  return plan.tasks.flatMap((task) => taskDependencyIssues(task, design, resolved));
}

function taskDependencyIssues(
  task: Task,
  design: ArchitectureDesign,
  resolved: Map<string, string>,
): string[] {
  const to = resolved.get(task.id);
  if (!to) return [];
  return task.dependsOn.flatMap((dependency) =>
    missingRelationIssue(task, dependency, design, resolved, to),
  );
}

function missingRelationIssue(
  task: Task,
  dependency: string,
  design: ArchitectureDesign,
  resolved: Map<string, string>,
  to: string,
): string[] {
  const from = resolved.get(dependency);
  if (!from || from === to) return [];
  if (hasDependencyRelation(design, from, to)) return [];
  return [
    `Task '${task.id}' depends on '${dependency}', but element '${from}' has no depends/calls relation to '${to}'`,
  ];
}

function hasDependencyRelation(design: ArchitectureDesign, from: string, to: string): boolean {
  return design.relations.some(
    (relation) => relation.from === from && relation.to === to && DEPENDS_KINDS.has(relation.kind),
  );
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
  const drafts = collectElementDrafts(plan.tasks);
  const taskElement = taskElementIndex(drafts);
  const relations = moduleRelations(plan.tasks, taskElement);
  return {
    ...plan,
    design: {
      summary: plan.summary,
      source,
      elements: draftsToElements(drafts),
      relations,
      sequence: relationsToSequence(relations),
    },
    tasks: plan.tasks.map((task) => withElementId(task, taskElement)),
  };
}

/** One module group of the DAG: the element an inferred design will carry. */
interface ElementDraft {
  id: string;
  paths: string[];
  tasks: Task[];
}

/** The top-level directories that are grouped one level deep (src/domain, web/src, ...). */
const APP_ROOTS = new Set(["src", "web", "app"]);

/** Group tasks by the module their first owned path points at, keeping first-seen order. */
function collectElementDrafts(tasks: Task[]): ElementDraft[] {
  const drafts = new Map<string, ElementDraft>();
  for (const task of tasks) {
    const id = slug(draftKeyFor(task));
    const draft = drafts.get(id) ?? { id, paths: [], tasks: [] };
    addOwnedPaths(draft, task);
    draft.tasks.push(task);
    drafts.set(id, draft);
  }
  return [...drafts.values()];
}

function draftKeyFor(task: Task): string {
  const parts = moduleParts(task.ownedPaths[0] ?? task.id);
  if (isAppModule(parts)) return parts.slice(0, 2).join("/");
  return parts[0] ?? task.id;
}

function moduleParts(key: string): string[] {
  return key
    .replace(/^\.?\//, "")
    .split("/")
    .filter((part) => part && !part.includes("*"));
}

/** `src/x`, `web/x` and `app/x` collapse to two path segments; anything else to one. */
function isAppModule(parts: string[]): boolean {
  return parts.length >= 2 && APP_ROOTS.has(parts[0]!);
}

function addOwnedPaths(draft: ElementDraft, task: Task): void {
  for (const owned of task.ownedPaths) {
    if (!draft.paths.includes(owned)) draft.paths.push(owned);
  }
}

/** Which element each task landed in. */
function taskElementIndex(drafts: ElementDraft[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const draft of drafts) {
    for (const task of draft.tasks) index.set(task.id, draft.id);
  }
  return index;
}

/** One depends relation per element pair, in the order the DAG first needs it. */
function moduleRelations(
  tasks: Task[],
  taskElement: Map<string, string>,
): ArchitectureDesign["relations"] {
  const relations: ArchitectureDesign["relations"] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const to = taskElement.get(task.id);
    if (!to) continue;
    addDependencyRelations(relations, seen, task.dependsOn, taskElement, to);
  }
  return relations;
}

function addDependencyRelations(
  relations: ArchitectureDesign["relations"],
  seen: Set<string>,
  dependencies: string[],
  taskElement: Map<string, string>,
  to: string,
): void {
  for (const dependency of dependencies) {
    const from = taskElement.get(dependency);
    if (isCrossModule(from, to)) addRelationOnce(relations, seen, from, to);
  }
}

/** Narrows `from` to the element id of a dependency that lives in another module. */
function isCrossModule(from: string | undefined, to: string): from is string {
  return from !== undefined && from !== to;
}

function addRelationOnce(
  relations: ArchitectureDesign["relations"],
  seen: Set<string>,
  from: string,
  to: string,
): void {
  const key = `${from}->${to}`;
  if (seen.has(key)) return;
  seen.add(key);
  relations.push({ from, to, kind: "depends" });
}

function draftsToElements(drafts: ElementDraft[]): ArchitectureDesign["elements"] {
  return drafts.map((draft) => ({
    id: draft.id,
    name: draft.id,
    kind: "module" as const,
    responsibility: draft.tasks.map((task) => task.title).join("；"),
    paths: draft.paths,
  }));
}

function relationsToSequence(relations: ArchitectureDesign["relations"]): ArchitectureDesign["sequence"] {
  return relations.map((relation, index) => ({
    order: index + 1,
    from: relation.from,
    to: relation.to,
    action: "交接",
  }));
}

function withElementId(task: Task, taskElement: Map<string, string>): Task {
  return { ...task, elementId: taskElement.get(task.id) ?? null };
}

/**
 * Bind each element to the deepest directory that covers its paths.
 * The model is not asked for this id; a missing tree clears any value that arrived with the plan.
 */
export function attachTreeNodes(plan: TaskPlan, tree: RepoTree | undefined): TaskPlan {
  if (!plan.design) return plan;
  return {
    ...plan,
    design: {
      ...plan.design,
      elements: plan.design.elements.map((element) => linkElement(element, tree)),
    },
  };
}

function linkElement(element: ArchitectureElement, tree: RepoTree | undefined): ArchitectureElement {
  const nodeId = tree ? deepestDirectory(tree, element.paths) : undefined;
  const next = { ...element } as ArchitectureElement & { nodeId?: string };
  if (nodeId) next.nodeId = nodeId;
  else delete next.nodeId;
  return next;
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
