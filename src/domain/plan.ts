import type { TaskPlan } from "./contracts.js";

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
