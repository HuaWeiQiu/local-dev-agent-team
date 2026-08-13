import { z } from "zod";
import type {
  FinalDecision,
  GoalIntake,
  ReviewVerdict,
  Task,
  TaskPlan,
  TestVerdict,
} from "../domain/contracts.js";
import type { QualityReport } from "../quality/run.js";
import type { ResolvedStrategy } from "../strategies/resolve.js";
import type {
  ApprovalRequest,
  RecoveryRecord,
  RunCheckpoint,
  RunRoleBinding,
  RunState,
  RunUsage,
} from "./types.js";

/** Schema version written into new state.json documents; legacy files without it are treated as 1. */
export const runStateSchemaVersion = 1;

export const runStatusSchema = z.enum([
  "created",
  "orchestrating",
  "exploring",
  "architecting",
  "planned",
  "implementing",
  "reviewing-testing",
  "reworking",
  "integrating",
  "final-checks",
  "awaiting-human",
  "publishing",
  "waiting-ci",
  "ci-failed",
  "repairing",
  "ready-to-merge",
  "completed",
  "cancelled",
  "interrupted",
  "blocked",
]);

export const taskStatusSchema = z.enum([
  "pending",
  "working",
  "reworking",
  "passed",
  "merged",
  "blocked",
]);

/**
 * Nested documents are validated at their own boundaries (plan intake, quality
 * gates, review/test verdicts, ...). Persisted state only requires them to be
 * objects so legacy fields survive a load/save round-trip untouched.
 */
const nested = <T extends object>() =>
  z.custom<T>((value) => typeof value === "object" && value !== null);

const stateEventSchema = z.looseObject({
  at: z.string(),
  status: runStatusSchema,
  message: z.string(),
});

const taskRunStateSchema = z.looseObject({
  task: nested<Task>(),
  status: taskStatusSchema,
  attempts: z.number(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  commit: z.string().optional(),
  mergeCommit: z.string().optional(),
  profile: z.string().optional(),
  quality: nested<QualityReport>().optional(),
  review: nested<ReviewVerdict>().optional(),
  test: nested<TestVerdict>().optional(),
  error: z.string().optional(),
});

const runRoleBindingSchema = z.looseObject({
  cli: z.enum(["codex", "grok", "kimi", "claude"]),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  profileName: z.string(),
});

const runUsageSchema = z.looseObject({
  agentInvocations: z.number(),
  agentDurationMs: z.number(),
  processOutputBytes: z.number(),
  truncatedStreams: z.number(),
  artifactBytes: z.number(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reportedCostUsd: z.number().optional(),
});

export const runStateSchema = z.looseObject({
  id: z.string().min(1),
  version: z.number().int().min(1).optional(),
  traceId: z.string().optional(),
  goal: z.string(),
  root: z.string(),
  configPath: z.string(),
  baseBranch: z.string(),
  baseCommit: z.string(),
  integrationBranch: z.string(),
  integrationWorktree: z.string(),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  profileOverrides: z.record(z.string(), z.string()),
  roleBindings: z.record(z.string(), runRoleBindingSchema).optional(),
  strategy: nested<ResolvedStrategy>(),
  supervisorId: z.string().optional(),
  parentRunId: z.string().optional(),
  purpose: z.enum(["evolution-evaluation", "evolution-proposer"]).optional(),
  intake: nested<GoalIntake>().optional(),
  plan: nested<TaskPlan>().optional(),
  tasks: z.array(taskRunStateSchema),
  finalQuality: nested<QualityReport>().optional(),
  finalDecision: nested<FinalDecision>().optional(),
  checkpoints: z.array(nested<RunCheckpoint>()).optional(),
  approvals: z.array(nested<ApprovalRequest>()).optional(),
  recoveries: z.array(nested<RecoveryRecord>()).optional(),
  resumeCount: z.number().optional(),
  usage: runUsageSchema.optional(),
  pullRequestUrl: z.string().optional(),
  pullRequestNumber: z.number().optional(),
  repository: z.string().optional(),
  githubRepairAttempts: z.number().optional(),
  history: z.array(stateEventSchema),
  error: z.string().optional(),
});

export function parseRunState(raw: unknown): RunState {
  const result = runStateSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at '${issue.path.join(".")}'` : "";
    throw new Error(`invalid run state${where}: ${issue?.message ?? "schema mismatch"}`);
  }
  return result.data as unknown as RunState;
}
