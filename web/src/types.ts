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

export type TaskStatus = "pending" | "working" | "reworking" | "passed" | "merged" | "blocked";

export interface WorkspaceProject {
  id: string;
  name: string;
  defaultBranch: string;
}

export interface WorkspaceInfo {
  mode: "single" | "workspace";
  defaultProjectId: string;
  projects: WorkspaceProject[];
}

export interface ProjectScope {
  mode: WorkspaceInfo["mode"];
  projectId: string;
}

export interface ProfileSummary {
  adapter: string;
  model: string;
  reasoning: string;
  permission: string;
  externalTools: "deny" | "inherit";
}

export interface RolePolicy {
  defaultProfile: string;
  allowedProfiles: string[];
  fallbackProfiles: string[];
}

export type StrategyTopologyMode = "parallel-dag" | "sequential";

export interface CompiledStrategyStage {
  id: string;
  kind: "agent" | "worker-pool" | "quality-gate" | "human-approval" | "publication";
  label: string;
  roles: string[];
}

export interface CompiledStrategyTopology {
  version: 1;
  mode: StrategyTopologyMode;
  stages: CompiledStrategyStage[];
  edges: Array<{ source: string; target: string }>;
}

export interface StrategyDefinition {
  topology?: { mode: StrategyTopologyMode };
  compiledTopology: CompiledStrategyTopology;
  source: "config" | "custom";
  maxParallel?: number;
  maxReworkAttempts?: number;
  executionTimeoutSeconds?: number;
  maxAgentInvocations?: number;
  maxProcessOutputBytes?: number;
  maxArtifactBytes?: number;
  roleProfiles: Record<string, string>;
  approvalGates?: Array<"plan" | "final">;
  approvalTimeoutSeconds?: number;
}

export type StrategyBlueprintDefinition = Omit<
  StrategyDefinition,
  "compiledTopology" | "source"
>;

export interface StrategyBlueprintResult {
  name: string;
  definition: StrategyDefinition;
  resolved: {
    name: string;
    maxParallel: number;
    maxReworkAttempts: number;
    maxAgentInvocations: number;
    approvalGates: Array<"plan" | "final">;
    topology: CompiledStrategyTopology;
  };
}

export interface ApprovalRequest {
  id: string;
  gate: "plan" | "final";
  status: "pending" | "approved" | "rejected";
  summary: string;
  checkpointId: string;
  requestedAt: string;
  expiresAt: string;
  response?: {
    decision: "approved" | "rejected";
    actor: string;
    reason: string;
    respondedAt: string;
  };
}

export interface RunCheckpoint {
  id: string;
  version: 1;
  stage: "plan-ready" | "task-wave-integrated" | "tasks-complete" | "local-gates-passed";
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

export interface PublicConfig {
  project: {
    name: string;
    defaultBranch: string;
    stateDirectory: string;
    maxParallel: number;
  };
  profiles: Record<string, ProfileSummary>;
  roles: Record<string, RolePolicy>;
  strategies: {
    default: string;
    definitions: Record<string, StrategyDefinition>;
  };
  observability: { maxEventsPerRun: number };
  interop: {
    schemaVersion: 1;
    adapters: Array<{
      name: string;
      contractVersion: 1;
      transport: "local-process";
      reasoning: string[];
      permissions: string[];
      externalTools: string[];
      structuredOutput: boolean;
      usage: string[];
    }>;
    protocols: {
      mcp: {
        specification: string;
        mode: string;
        defaultPolicy: "deny";
        executionOwner: "agent-cli";
      };
      a2a: { specification: string; mode: "disabled"; requires: string[] };
    };
    configuredProfiles: Array<{
      name: string;
      adapter: string;
      permission: string;
      externalTools: "deny" | "inherit";
    }>;
  };
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

export interface Task {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  ownedPaths: string[];
  acceptanceCommands: Array<{ command: string; args: string[] }>;
  profile: string | null;
}

export interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  path: string;
  line: number | null;
  message: string;
  required: boolean;
}

export interface TaskRunState {
  task: Task;
  status: TaskStatus;
  attempts: number;
  branch?: string;
  worktree?: string;
  commit?: string;
  profile?: string;
  quality?: {
    passed: boolean;
    commands: Array<{
      spec: { command: string; args: string[] };
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
    }>;
  };
  review?: {
    verdict: "approve" | "request_changes" | "escalate";
    summary: string;
    findings: Finding[];
  };
  test?: {
    verdict: "approve" | "request_changes" | "escalate";
    summary: string;
    missingTests: string[];
  };
  error?: string;
}

export interface RunState {
  id: string;
  traceId?: string;
  goal: string;
  status: RunStatus;
  strategy: {
    name: string;
    maxParallel: number;
    maxReworkAttempts: number;
    executionTimeoutSeconds: number;
    maxAgentInvocations: number;
    maxProcessOutputBytes: number;
    maxArtifactBytes: number;
    roleProfiles: Record<string, string>;
    approvalGates: Array<"plan" | "final">;
    approvalTimeoutSeconds: number;
    topology?: CompiledStrategyTopology;
  };
  profileOverrides: Record<string, string>;
  parentRunId?: string;
  createdAt: string;
  updatedAt: string;
  plan?: { summary: string; tasks: Task[] };
  tasks: TaskRunState[];
  history: Array<{ at: string; status: RunStatus; message: string }>;
  finalQuality?: { passed: boolean };
  finalDecision?: { decision: "ready" | "escalate"; reason: string };
  checkpoints?: RunCheckpoint[];
  approvals?: ApprovalRequest[];
  recoveries?: RecoveryRecord[];
  resumeCount?: number;
  usage?: {
    agentInvocations: number;
    agentDurationMs: number;
    processOutputBytes: number;
    truncatedStreams: number;
    artifactBytes: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reportedCostUsd?: number;
  };
  error?: string;
}

export interface RunEvent {
  sequence: number;
  id: string;
  schemaVersion: 1;
  runId: string;
  type: string;
  occurredAt: string;
  payload: unknown;
  traceId: string;
  spanId: string;
}

export type EvidenceCheckStatus = "pass" | "fail" | "pending";

export interface RunEvidence {
  runId: string;
  status: RunStatus;
  readiness: "ready" | "attention" | "in-progress";
  checks: Array<{
    id: "tasks" | "quality" | "decision" | "approval";
    label: string;
    status: EvidenceCheckStatus;
    detail: string;
  }>;
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
  artifacts: Array<{
    path: string;
    size: number;
    kind: "context" | "agent-output" | "quality" | "review" | "test" | "other";
    previewable: boolean;
  }>;
  artifactBytes: number;
  diff: {
    available: boolean;
    baseCommit: string;
    targetCommit?: string;
    changedFiles: string[];
    content?: string;
    truncated: boolean;
    detail?: string;
  };
}

export interface EvidenceFilePreview {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

export interface RunCleanupPreview {
  token: string;
  expiresAt: string;
  olderThanDays: number;
  cutoff: string;
  candidates: Array<{
    id: string;
    goal: string;
    status: "completed" | "cancelled" | "blocked";
    updatedAt: string;
    bytes: number;
  }>;
  totalBytes: number;
}

export interface RunCleanupResult {
  deletedRunIds: string[];
  reclaimedBytes: number;
}

export interface StartRunInput {
  goal: string;
  strategy?: string;
  profileOverrides: Record<string, string>;
}

export interface UsageDetail {
  agentInvocations: number;
  agentDurationMs: number;
  processOutputBytes: number;
  truncatedStreams: number;
  artifactBytes: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reportedCostUsd: number;
  costReported: boolean;
}

export interface RunUsageEntry {
  runId: string;
  goal: string;
  status: RunStatus;
  strategy: string;
  createdAt: string;
  updatedAt: string;
  usage: UsageDetail;
}

export interface UsageReport {
  generatedAt: string;
  runCount: number;
  totals: UsageDetail;
  runs: RunUsageEntry[];
}
