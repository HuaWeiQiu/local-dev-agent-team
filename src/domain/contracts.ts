import { z } from "zod";
import { commandSchema } from "./commands.js";

export const goalIntakeSchema = z.object({
  goalSummary: z.string().min(1),
  instructionsForArchitect: z.string().min(1),
  constraints: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"]),
});

export const taskSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  title: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string()),
  ownedPaths: z.array(z.string().min(1)).min(1),
  acceptanceCommands: z.array(commandSchema),
  profile: z.string().nullable(),
  /** Optional batch affinity for swarm wave packing (same key preferred together). */
  batchKey: z.string().min(1).max(64).nullable().optional(),
  /**
   * Evidence contract for the task. `host-evidence` means the work is verified
   * on a real host and may omit acceptanceCommands. Default is repository
   * commands / review.
   */
  evidenceKind: z.enum(["commands", "host-evidence"]).nullable().optional(),
  /** Element in `plan.design` this task implements. */
  elementId: z.string().min(1).nullable().optional(),
});

export const architectureElementSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  name: z.string().min(1),
  kind: z.enum(["module", "interface", "data"]),
  responsibility: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});

export const architectureRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["calls", "reads", "writes", "depends"]),
  label: z.string().min(1).optional(),
});

export const architectureStepSchema = z.object({
  order: z.number().int().positive(),
  from: z.string().min(1),
  to: z.string().min(1),
  action: z.string().min(1),
});

export const architectureDesignSchema = z.object({
  summary: z.string().min(1),
  /** Who produced the model. Inferred diagrams are a fallback, not an architect deliverable. */
  source: z.enum(["architect", "inferred", "controller"]).default("architect"),
  elements: z.array(architectureElementSchema).min(1),
  relations: z.array(architectureRelationSchema).default([]),
  sequence: z.array(architectureStepSchema).default([]),
});

export const exploreSummarySchema = z.object({
  summary: z.string().min(1),
  modules: z.array(z.string()).default([]),
  riskPaths: z.array(z.string()).default([]),
  suggestedAcceptanceCommands: z.array(z.string()).default([]),
  forbiddenPaths: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export const taskPlanSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(taskSchema).min(1),
  design: architectureDesignSchema.optional(),
});

export const findingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  message: z.string().min(1),
  required: z.boolean(),
});

export const reviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "escalate"]),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
});

export const testVerdictSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "escalate"]),
  summary: z.string().min(1),
  missingTests: z.array(z.string()),
});

export const finalDecisionSchema = z.object({
  decision: z.enum(["ready", "escalate"]),
  reason: z.string().min(1),
});

export const advisorVerdictSchema = z.object({
  recommendation: z.enum(["proceed", "change_approach", "stop"]),
  summary: z.string().min(1),
  advice: z.string().min(1),
  risks: z.array(z.string()),
});

export type AdvisorVerdict = z.infer<typeof advisorVerdictSchema>;
export type GoalIntake = z.infer<typeof goalIntakeSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export type ArchitectureDesign = z.infer<typeof architectureDesignSchema>;
export type ArchitectureElement = z.infer<typeof architectureElementSchema>;
export type ExploreSummary = z.infer<typeof exploreSummarySchema>;
export type Finding = z.infer<typeof findingSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type TestVerdict = z.infer<typeof testVerdictSchema>;
export type FinalDecision = z.infer<typeof finalDecisionSchema>;
