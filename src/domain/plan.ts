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
    .sort((left, right) => left.id.localeCompare(right.id));

  const wave: TaskPlan["tasks"] = [];
  for (const candidate of ready) {
    if (wave.length >= maxParallel) {
      break;
    }
    if (wave.every((selected) => !pathsMayOverlap(selected.ownedPaths, candidate.ownedPaths))) {
      wave.push(candidate);
    }
  }
  if (wave.length === 0 && ready.length > 0) {
    return [ready[0]!];
  }
  return wave;
}
