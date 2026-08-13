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
import type { ApprovalGate } from "../config/schema.js";

export type RunStatus =
  | "created"
  | "orchestrating"
  | "exploring"
  | "architecting"
  | "planned"
  | "implementing"
  | "reviewing-testing"
  | "reworking"
  | "integrating"
  | "final-checks"
  | "awaiting-human"
  | "publishing"
  | "waiting-ci"
  | "ci-failed"
  | "repairing"
  | "ready-to-merge"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "blocked";

export type TaskStatus =
  | "pending"
  | "working"
  | "reworking"
  | "passed"
  | "merged"
  | "blocked";

export interface TaskRunState {
  task: Task;
  status: TaskStatus;
  attempts: number;
  branch?: string;
  worktree?: string;
  commit?: string;
  /** Integration-branch merge commit produced when this task was merged. */
  mergeCommit?: string;
  /**
   * Crash-window marker: set to the task branch just before `git merge` so a
   * crash between the merge and the next save can be recognized during
   * recovery by matching the deterministic merge-commit subject.
   */
  merging?: string;
  profile?: string;
  quality?: QualityReport;
  review?: ReviewVerdict;
  test?: TestVerdict;
  error?: string;
}

export interface StateEvent {
  at: string;
  status: RunStatus;
  message: string;
}

export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalResponse {
  decision: ApprovalDecision;
  actor: string;
  reason: string;
  respondedAt: string;
}

export interface ApprovalRequest {
  id: string;
  gate: ApprovalGate;
  status: "pending" | ApprovalDecision;
  summary: string;
  checkpointId: string;
  requestedAt: string;
  expiresAt: string;
  response?: ApprovalResponse;
}

export type CheckpointStage =
  | "plan-ready"
  | "task-wave-integrated"
  | "tasks-complete"
  | "local-gates-passed";

export interface RunCheckpoint {
  id: string;
  version: 1;
  stage: CheckpointStage;
  integrationCommit: string;
  completedTaskIds: string[];
  createdAt: string;
}

export interface RecoveryRecord {
  at: string;
  actor: string;
  reason: string;
  checkpointId: string;
  abandonedTasks: Array<{
    taskId: string;
    status: TaskStatus;
    attempts: number;
    branch?: string;
    worktree?: string;
    commit?: string;
  }>;
}

export interface RunUsage {
  agentInvocations: number;
  agentDurationMs: number;
  processOutputBytes: number;
  truncatedStreams: number;
  artifactBytes: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reportedCostUsd?: number;
}

export interface RunSummary {
  id: string;
  goal: string;
  status: RunStatus;
  strategy: string;
  createdAt: string;
  updatedAt: string;
  taskCounts: Record<TaskStatus, number>;
  error?: string;
  parentRunId?: string;
}

export interface RunRoleBinding {
  cli: "codex" | "grok" | "kimi" | "claude";
  model?: string;
  reasoning?: string;
  /** Ephemeral profile materialized for this run. */
  profileName: string;
}

export interface RunState {
  id: string;
  /** Persisted document schema version; legacy files without it are treated as 1. */
  version?: number;
  traceId?: string;
  goal: string;
  root: string;
  configPath: string;
  baseBranch: string;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktree: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  profileOverrides: Record<string, string>;
  /** CLI/model/reasoning actually bound per role (global picker or evolution defaults). */
  roleBindings?: Record<string, RunRoleBinding>;
  strategy: ResolvedStrategy;
  supervisorId?: string;
  parentRunId?: string;
  purpose?: "evolution-evaluation" | "evolution-proposer";
  intake?: GoalIntake;
  plan?: TaskPlan;
  tasks: TaskRunState[];
  finalQuality?: QualityReport;
  finalDecision?: FinalDecision;
  checkpoints?: RunCheckpoint[];
  approvals?: ApprovalRequest[];
  recoveries?: RecoveryRecord[];
  resumeCount?: number;
  /**
   * Wall-clock execution time consumed by run/resume segments, accumulated
   * across pauses and interruptions. Resume prorates the strategy's
   * execution timeout against this figure instead of restarting the full
   * budget; a run whose accumulated time reached the limit is blocked.
   */
  executionElapsedMs?: number;
  usage?: RunUsage;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  repository?: string;
  githubRepairAttempts?: number;
  history: StateEvent[];
  error?: string;
}
