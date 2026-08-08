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
}

export interface RunState {
  id: string;
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
  strategy: ResolvedStrategy;
  supervisorId?: string;
  parentRunId?: string;
  intake?: GoalIntake;
  plan?: TaskPlan;
  tasks: TaskRunState[];
  finalQuality?: QualityReport;
  finalDecision?: FinalDecision;
  checkpoints?: RunCheckpoint[];
  approvals?: ApprovalRequest[];
  recoveries?: RecoveryRecord[];
  resumeCount?: number;
  usage?: RunUsage;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  repository?: string;
  githubRepairAttempts?: number;
  history: StateEvent[];
  error?: string;
}
