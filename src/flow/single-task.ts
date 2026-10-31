import type { TaskPlan } from "../domain/contracts.js";

const MAX_TITLE = 80;

/**
 * The quick flow treats the whole goal as one task. It may touch any path in
 * its own worktree; the deterministic quality gates still decide whether the
 * result is accepted.
 */
export function singleTaskPlan(goal: string): TaskPlan {
  const firstLine = goal.trim().split(/\r?\n/, 1)[0] ?? goal;
  const title = firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE - 1)}…` : firstLine;
  return {
    summary: "Single-task plan: the whole goal is one implementation task.",
    tasks: [
      {
        id: "T1",
        title: title || "Implement the goal",
        description: goal.trim(),
        dependsOn: [],
        ownedPaths: ["**"],
        acceptanceCommands: [],
        profile: null,
        evidenceKind: "commands",
      },
    ],
  };
}
