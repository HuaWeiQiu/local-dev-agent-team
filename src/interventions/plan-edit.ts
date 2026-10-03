import { designIssues } from "../domain/architecture-design.js";
import type { TaskPlan } from "../domain/contracts.js";
import { taskPlanSchema } from "../domain/contracts.js";
import { validateTaskPlan } from "../domain/plan.js";
import type { AgentTeamConfig } from "../config/schema.js";

export interface PlanEditSummary {
  added: string[];
  removed: string[];
  changed: string[];
  summaryChanged: boolean;
}

/**
 * Validates an operator-edited plan with the same structural rules as an
 * architect plan, plus the worker profile allow-list. Throws a readable error.
 */
export function parseEditedPlan(input: unknown, config: AgentTeamConfig): TaskPlan {
  const parsed = taskPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Edited plan is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const plan = parsed.data;
  validateTaskPlan(plan);
  if (plan.design) {
    const issues = designIssues(plan);
    if (issues.length > 0) {
      throw new Error(`Edited plan design does not match its tasks: ${issues.join("; ")}`);
    }
  }
  const allowed = config.roles.worker?.allowedProfiles ?? [];
  for (const task of plan.tasks) {
    if (task.profile !== null && !allowed.includes(task.profile)) {
      throw new Error(`Task '${task.id}' uses profile '${task.profile}', which the worker role does not allow`);
    }
  }
  return plan;
}

export function summarizePlanEdit(before: TaskPlan, after: TaskPlan): PlanEditSummary {
  const previous = new Map(before.tasks.map((task) => [task.id, JSON.stringify(task)]));
  const next = new Map(after.tasks.map((task) => [task.id, JSON.stringify(task)]));
  return {
    added: [...next.keys()].filter((id) => !previous.has(id)),
    removed: [...previous.keys()].filter((id) => !next.has(id)),
    changed: [...next.keys()].filter((id) => previous.has(id) && previous.get(id) !== next.get(id)),
    summaryChanged: before.summary !== after.summary,
  };
}

export function planEditIsEmpty(summary: PlanEditSummary): boolean {
  return (
    summary.added.length === 0
    && summary.removed.length === 0
    && summary.changed.length === 0
    && !summary.summaryChanged
  );
}
