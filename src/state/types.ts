import type {
  FinalDecision,
  GoalIntake,
  ReviewVerdict,
  Task,
  TaskPlan,
  TestVerdict,
} from "../domain/contracts.js";
import type { QualityReport } from "../quality/run.js";

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

export interface RunState {
  id: string;
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
  intake?: GoalIntake;
  plan?: TaskPlan;
  tasks: TaskRunState[];
  finalQuality?: QualityReport;
  finalDecision?: FinalDecision;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  repository?: string;
  githubRepairAttempts?: number;
  history: StateEvent[];
  error?: string;
}
