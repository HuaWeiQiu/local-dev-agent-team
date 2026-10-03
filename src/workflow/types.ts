import type { LoadedConfig } from "../config/load.js";
import type { RoleAgentService } from "../agents/service.js";
import type { LiveSupport } from "../agents/live-invoke.js";
import type { FlowTemplateName } from "../flow/index.js";
import type { AdvisorVerdict, ExploreSummary, GoalIntake, TaskPlan } from "../domain/contracts.js";
import { type GitManager } from "../git/manager.js";
import { type RunStateStore } from "../state/store.js";
import type { RunCheckpoint, RunRoleBinding, RunState } from "../state/types.js";
import { type RunArtifactCleaner } from "./cleanup.js";
import { type RunExperienceRecorder } from "./experience-recorder.js";
import type { ForkAdvisor } from "../jev/policy.js";
import type { RunEventSink } from "../events/types.js";
import { type RunBudgetTracker } from "../observability/budget.js";

export type WorkflowRoleBindings = Record<
  string,
  { cli: RunRoleBinding["cli"]; model?: string | undefined; reasoning?: string | undefined }
>;

export interface WorkflowRunOptions {
  goal: string;
  profileOverrides?: Record<string, string>;
  roleBindings?: WorkflowRoleBindings;
  strategyName?: string;
  runId?: string;
  signal?: AbortSignal;
  supervisorId?: string;
  parentRunId?: string;
  purpose?: "evolution-evaluation";
  /** Operator-chosen workflow template; otherwise the router decides. */
  template?: FlowTemplateName;
}

export interface RunContext {
  state: RunState;
  store: RunStateStore;
  git: GitManager;
  agent: RoleAgentService;
  budget: RunBudgetTracker;
  signal?: AbortSignal | undefined;
  planningGoal?: string;
  allowImpliedHandover?: boolean;
  verifiedExperiences?: unknown;
  deterministicPlan?: TaskPlan;
  intake?: GoalIntake;
  exploreSummary?: ExploreSummary | undefined;
  planCheckpoint?: RunCheckpoint;
  preFinalAdvice?: AdvisorVerdict | undefined;
  finalCheckpoint?: RunCheckpoint;
}

export interface WorkflowDependencies {
  createAgentService?: (
    store: RunStateStore,
    profileOverrides: Record<string, string>,
    signal?: AbortSignal,
  ) => RoleAgentService;
  eventSink?: RunEventSink;
  /** Live agent sessions; absent means every role runs one-shot. */
  live?: LiveSupport;
  /** Overrides the client built from `config.jev`; mainly for tests. */
  forkAdvisor?: ForkAdvisor;
}

export interface WorkflowResumeOptions {
  mode: "approval" | "recovery";
  actor: string;
  reason: string;
  signal?: AbortSignal;
  supervisorId?: string;
}

/** Shared, read-only collaborators every workflow stage works against. */
export interface RunnerEnv {
  readonly loaded: LoadedConfig;
  readonly dependencies: WorkflowDependencies;
  readonly runsDirectory: string;
  readonly worktreesDirectory: string;
  readonly forkAdvisor: ForkAdvisor | undefined;
  readonly experience: RunExperienceRecorder;
  readonly cleaner: RunArtifactCleaner;
}
