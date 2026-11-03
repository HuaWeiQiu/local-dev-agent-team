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
  const plan = parsablePlan(input);
  validateTaskPlan(plan);
  assertDesignMatchesTasks(plan);
  assertWorkerProfilesAllowed(plan, config);
  return plan;
}

function parsablePlan(input: unknown): TaskPlan {
  const parsed = taskPlanSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Edited plan is invalid: ${detail}`);
}

function assertDesignMatchesTasks(plan: TaskPlan): void {
  if (!plan.design) return;
  const issues = designIssues(plan);
  if (issues.length > 0) {
    throw new Error(`Edited plan design does not match its tasks: ${issues.join("; ")}`);
  }
}

function assertWorkerProfilesAllowed(plan: TaskPlan, config: AgentTeamConfig): void {
  const allowed = config.roles.worker?.allowedProfiles ?? [];
  for (const task of plan.tasks) {
    const disallowed = task.profile !== null && !allowed.includes(task.profile);
    if (!disallowed) continue;
    throw new Error(
      `Task '${task.id}' uses profile '${task.profile}', which the worker role does not allow`,
    );
  }
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
