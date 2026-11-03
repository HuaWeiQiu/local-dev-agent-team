import type { RunStatus, TaskStatus } from "../state/types.js";

export type EvidenceCheckStatus = "pass" | "fail" | "pending";

export interface EvidenceCheck {
  id: "tasks" | "quality" | "decision" | "approval";
  label: string;
  status: EvidenceCheckStatus;
  detail: string;
  /**
   * True when the check passed because nothing was required, not because the
   * thing was done. `status: "pass"` alone cannot tell those apart, and "did the
   * work" and "never needed to" call for different answers when a run is
   * audited — so the distinction has to exist in the payload, not only in the
   * wording of `detail`.
   */
  skipped?: boolean;
}

export interface EvidenceArtifact {
  path: string;
  size: number;
  kind: "context" | "agent-output" | "quality" | "review" | "test" | "other";
  previewable: boolean;
}

export interface IntegrationDiffEvidence {
  available: boolean;
  baseCommit: string;
  targetCommit?: string;
  changedFiles: string[];
  content?: string;
  truncated: boolean;
  detail?: string;
}

export interface TaskDiffEvidence {
  taskId: string;
  available: boolean;
  source?: "commit" | "worktree";
  commit?: string;
  changedFiles: string[];
  content?: string;
  truncated: boolean;
  detail?: string;
}

export interface RunEvidence {
  runId: string;
  status: RunStatus;
  readiness: "ready" | "attention" | "in-progress";
  checks: EvidenceCheck[];
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    attempts: number;
    commit?: string;
    qualityPassed?: boolean;
    reviewVerdict?: string;
    testVerdict?: string;
    findingCount: number;
  }>;
  artifacts: EvidenceArtifact[];
  artifactBytes: number;
  diff: IntegrationDiffEvidence;
}

export interface EvidenceFilePreview {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface RunCleanupCandidate {
  id: string;
  goal: string;
  status: "completed" | "cancelled" | "blocked" | "interrupted";
  updatedAt: string;
  bytes: number;
}

export interface RunCleanupPreview {
  token: string;
  expiresAt: string;
  olderThanDays: number;
  cutoff: string;
  candidates: RunCleanupCandidate[];
  totalBytes: number;
}

export interface RunCleanupResult {
  deletedRunIds: string[];
  reclaimedBytes: number;
}
