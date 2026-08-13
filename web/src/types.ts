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

export type TaskStatus = "pending" | "working" | "reworking" | "passed" | "merged" | "blocked";

export interface WorkspaceProject {
  id: string;
  name: string;
  defaultBranch: string;
}

export interface WorkspaceRegistryEntry {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  occupancy?: string;
  reason?: string;
}

export interface WorkspaceInfo {
  mode: "single" | "workspace";
  defaultProjectId: string;
  projects: WorkspaceProject[];
  /** Projects currently attached to this control service. */
  connectedCount?: number;
  /** All desktop-registered projects when a registry file is present. */
  registeredCount?: number;
  registry?: WorkspaceRegistryEntry[];
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

export interface TaskMorphology {
  explore?: {
    enabled?: boolean;
    profile?: string;
    maxInjectedChars?: number;
    failOpen?: boolean;
  };
  plan?: {
    role?: "architect";
  };
  implement?: {
    role?: "worker";
    swarm?: {
      maxConcurrency?: number;
    };
  };
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
  taskMorphology?: TaskMorphology;
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
  batchKey?: string | null;
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
    swarmMaxConcurrency?: number;
    explore?: {
      enabled: boolean;
      profile?: string;
      maxInjectedChars: number;
      failOpen: boolean;
    };
  };
  profileOverrides: Record<string, string>;
  roleBindings?: Record<string, {
    cli: "codex" | "grok" | "kimi" | "claude";
    model?: string;
    reasoning?: string;
    profileName: string;
  }>;
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
    status: "completed" | "cancelled" | "blocked" | "interrupted";
    updatedAt: string;
    bytes: number;
  }>;
  totalBytes: number;
}

export interface RunCleanupResult {
  deletedRunIds: string[];
  reclaimedBytes: number;
}

export type CliId = "codex" | "grok" | "kimi" | "claude";

export interface RoleBindingInput {
  cli: CliId;
  model?: string;
  reasoning?: string;
}

export interface StartRunInput {
  goal: string;
  strategy?: string;
  profileOverrides: Record<string, string>;
  roleBindings?: Record<string, RoleBindingInput>;
}

export interface CliModelInfo {
  id: string;
  label: string;
  provider?: string;
  reasoningOptions?: string[];
}

export interface CliProbeResult {
  id: CliId;
  binary?: string;
  installed: boolean;
  version?: string;
  auth: { status: "unknown" | "present" | "missing" | "invalid"; detail?: string };
  configPaths: string[];
  models: CliModelInfo[];
  defaultModel?: string;
  defaultReasoning?: string;
  providers?: Array<{ id: string; baseUrl?: string; wireApi?: string }>;
  runtimeSupported: boolean;
}

export interface CliInventory {
  scannedAt: string;
  home: string;
  clis: CliProbeResult[];
  /** Config-file fingerprint used for auto cache invalidation */
  sourceFingerprint?: string;
}

export type InventoryCacheReason = "refresh" | "stale" | "fingerprint" | "miss" | "hit";

export interface DesktopSettingsView {
  version: 1;
  defaults: { roles: Record<string, RoleBindingInput> };
  ui: {
    showCliPickerInRunLauncher: boolean;
    /** Soft auto re-check while settings is open / on interval */
    autoDetectCliConfig?: boolean;
    /** Soft re-check when window regains focus */
    autoDetectOnFocus?: boolean;
  };
  inventoryCachedAt: string | null;
}

export interface DesktopSettingsResponse {
  settings: DesktopSettingsView;
  inventory: CliInventory;
  fromCache: boolean;
  reason?: InventoryCacheReason;
  suggestedDefaults: Record<string, RoleBindingInput>;
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

export type EvolutionLifecycleStatus =
  | "proposed"
  | "evaluating"
  | "evaluated"
  | "promoted"
  | "rejected"
  | "rolled-back";

export type EvolutionCandidate =
  | {
      kind: "strategy-blueprint";
      name: string;
      definition: StrategyBlueprintDefinition;
    }
  | {
      kind: "role-prompt";
      path: string;
      contentDigest: string;
    };

export interface EvolutionEvidenceItem {
  kind: "deterministic" | "advisory";
  id: string;
  summary: string;
  status?: "pass" | "fail";
  verdict?: "approve" | "request_changes" | "escalate";
}

export interface EvolutionEvaluation {
  source:
    | "external"
    | "server-structural-preflight-v1"
    | "server-automatic-run-evaluation-v1";
  evidence: {
    proposalId: string;
    candidateDigest: string;
    items: EvolutionEvidenceItem[];
  };
  result: {
    proposalId: string;
    candidateDigest: string;
    passed: boolean;
    deterministicPassed: boolean;
    advisoryPassed: boolean;
    summary: string;
    failedDeterministicIds: string[];
    advisoryVerdicts: Array<"approve" | "request_changes" | "escalate">;
  };
  at: string;
}

export interface EvolutionApplication {
  proposalId: string;
  target:
    | { kind: "strategy-blueprint"; name: string }
    | { kind: "role-prompt"; path: string };
  status: "applied" | "adopted";
  beforeTargetDigest: string | null;
  afterTargetDigest: string;
  rollbackSafe: boolean;
  catalogRevision: number;
  operator: string;
  reason: string;
  appliedAt: string;
}

export interface EvolutionProposal {
  id: string;
  createdAt: string;
  status: EvolutionLifecycleStatus;
  /** ISO 时间；缺省表示未归档。归档候选默认不出现在列表中。 */
  archivedAt?: string;
  candidate: EvolutionCandidate;
  policy: {
    version: 1;
    capabilities: {
      automaticExecution: false;
      automaticPromotion: false;
      networkPublication: false;
      secretStorage: false;
    };
    allowedPromptPaths: string[];
  };
  transitions: Array<{
    from: EvolutionLifecycleStatus;
    to: EvolutionLifecycleStatus;
    at: string;
  }>;
  evaluation?: EvolutionEvaluation;
  application: EvolutionApplication | null;
}

export interface EvolutionAuditRecord {
  kind: "promotion" | "rejection" | "rollback";
  proposalId: string;
  actor: string;
  reason: string;
  at: string;
  previousActiveProposalId?: string | null;
  restoredActiveProposalId?: string | null;
}

export interface EvolutionCompletedApplication {
  operation: "promote-and-apply" | "rollback-applied" | "reconcile-promoted";
  proposalId: string;
  status: "applied" | "rolled-back" | "adopted" | "aborted" | "legacy-unreconciled";
  beforeTargetDigest: string | null;
  afterTargetDigest: string | null;
  catalogRevisionBefore: number;
  catalogRevisionAfter: number;
  operator: string;
  reason: string;
  completedAt: string;
}

export interface AutomaticEvolutionCycle {
  cycle: number;
  proposalId: string;
  rationale: string;
  candidateDefinition: StrategyBlueprintDefinition;
  candidateRunIds: string[];
  incumbentScore: number;
  candidateScore: number;
  scoreDelta: number;
  improved: boolean;
  decision: "promoted" | "rejected";
  completedAt: string;
}

export interface AutomaticEvolutionSnapshot {
  enabled: boolean;
  autoStart: false;
  status: "idle" | "running" | "stopping" | "completed" | "stopped" | "paused" | "failed";
  phase:
    | "idle"
    | "baseline"
    | "proposing"
    | "evaluating"
    | "deciding"
    | "applying"
    | "stopping"
    | "finished";
  configuredMaxCycles: number;
  requestedMaxCycles: number | null;
  completedCycles: number;
  maxConsecutiveNoImprovement: number;
  consecutiveNoImprovement: number;
  evaluationRepeats: number;
  minimumScoreDelta: number;
  baselineStrategy: string | null;
  targetStrategy: string;
  sessionId: string | null;
  activeRunId: string | null;
  incumbentScore: number | null;
  incumbentStrategy: string | null;
  stopReason: string | null;
  error: string | null;
  failureCode: string | null;
  roleBindingSource: "global-cli-defaults" | "project-yaml" | null;
  startedAt: string | null;
  updatedAt: string;
  lastEvaluation: {
    suiteName: string;
    suiteDigest: string;
    completedAt: string;
  } | null;
  cycles: AutomaticEvolutionCycle[];
}

export interface EvolutionSnapshot {
  catalogRevision: number;
  applicationRevision: number;
  recoveryRequired: boolean;
  promptRoles: Array<{ role: string; path: string }>;
  proposals: EvolutionProposal[];
  activeProposals: Array<{
    target:
      | { kind: "strategy-blueprint"; name: string }
      | { kind: "role-prompt"; path: string };
    proposalId: string;
  }>;
  auditRecords: EvolutionAuditRecord[];
  completedApplications: EvolutionCompletedApplication[];
  pendingOperation: {
    operation: "promote-and-apply" | "rollback-applied" | "reconcile-promoted";
    proposalId: string;
    startedAt: string;
  } | null;
  automation: AutomaticEvolutionSnapshot;
  evidenceScope: "server-structural-preflight-not-candidate-execution";
}

export type EvolutionPreviewMaterial =
  | {
      kind: "role-prompt";
      identity: string;
      digest: string | null;
      present: boolean;
      content: string | null;
    }
  | {
      kind: "strategy-blueprint";
      identity: string;
      digest: string | null;
      present: boolean;
      definition: StrategyBlueprintDefinition | null;
    };

export interface EvolutionApplicationPreview {
  token: string;
  kind: "promote-and-apply" | "rollback-applied";
  proposalId: string;
  candidateDigest: string;
  catalogRevision: number;
  activeProposalId: string | null;
  currentTargetDigest: string | null;
  operator: string;
  expiresAt: string;
  beforeTarget: {
    kind: EvolutionCandidate["kind"];
    identity: string;
    digest: string | null;
    present: boolean;
    mode?: number;
  };
  afterTarget: {
    kind: EvolutionCandidate["kind"];
    identity: string;
    digest: string | null;
    present: boolean;
    mode?: number;
  };
}

export interface EvolutionPreviewResponse {
  preview: EvolutionApplicationPreview;
  description: {
    kind: "promote-and-apply" | "rollback-applied";
    proposalId: string;
    before: EvolutionPreviewMaterial;
    after: EvolutionPreviewMaterial;
  };
  evidenceScope?: "server-structural-preflight-not-candidate-execution";
}

export type ExperienceStatus = "candidate" | "verified" | "rejected" | "retired";
export type ExperienceSensitivity = "low" | "medium" | "high";
export type ExperienceScope = "project" | "shared";
export type ExperiencePortability = "project-bound" | "cross-project";

export interface ExperienceEntry {
  id: string;
  project: string;
  status: ExperienceStatus;
  summary: string;
  conditions: string[];
  sourceRunId: string;
  suiteDigest?: string;
  sensitivity: ExperienceSensitivity;
  scope: ExperienceScope;
  portability: ExperiencePortability;
  tags: string[];
  sourceProjectId?: string;
  hitCount: number;
  successCount: number;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  verifiedBy?: string;
}

export interface ExperienceSnapshot {
  project: string;
  projectPath: string;
  sharedPath: string;
  enabled: boolean;
  injectIntoPlanning: boolean;
  injectIntoRework?: boolean;
  extractOnTerminal: boolean;
  requireSuiteForPromote?: boolean;
  counts: {
    project: number;
    shared: number;
    verified: number;
    candidate: number;
  };
  entries: ExperienceEntry[];
}

export interface ExperiencePlanningBundle {
  note: string;
  items: Array<{
    id: string;
    summary: string;
    conditions: string[];
    tags: string[];
    scope: ExperienceScope;
    hitCount: number;
  }>;
}
