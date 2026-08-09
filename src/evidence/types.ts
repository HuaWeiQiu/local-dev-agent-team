import type { RunStatus, TaskStatus } from "../state/types.js";

export type EvidenceCheckStatus = "pass" | "fail" | "pending";

export interface EvidenceCheck {
  id: "tasks" | "quality" | "decision" | "approval";
  label: string;
  status: EvidenceCheckStatus;
  detail: string;
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
  status: "completed" | "cancelled" | "blocked";
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
