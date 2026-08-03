import { z } from "zod";
import { commandSchema } from "../config/schema.js";

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
});

export const taskPlanSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(taskSchema).min(1),
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

export type GoalIntake = z.infer<typeof goalIntakeSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type TestVerdict = z.infer<typeof testVerdictSchema>;
export type FinalDecision = z.infer<typeof finalDecisionSchema>;
