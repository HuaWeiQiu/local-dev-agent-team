import type { RoleAgentService } from "../agents/service.js";
import { activeFlow, taskStepEnabled, type TriageEvent } from "../flow/index.js";
import { reviewVerdictSchema, testVerdictSchema, type AdvisorVerdict, type ReviewVerdict, type TestVerdict } from "../domain/contracts.js";
import { reviewVerdictJsonSchema, testVerdictJsonSchema } from "../domain/json-schemas.js";
import { taskUsesProjectQualityGates } from "../domain/plan.js";
import { type GitManager } from "../git/manager.js";
import { ensureWorktreeNodeModules } from "../quality/install.js";
import { runQualityWithRerun } from "../quality/flaky.js";
import { deduplicateCommands, type QualityReport } from "../quality/run.js";
import { TaskBudgetAgent, TaskBudgetExceededError, type TaskBudgetLimits } from "../reliability/task-budget.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState, TaskRunState } from "../state/types.js";
import { pathExists, taskArtifactKey } from "./state-helpers.js";
import { isPlaceholderVerdict, shouldAcceptDocsDespiteEscalate, isHardSpecialistEscalation, shouldTrustQualityOverReview, passesTaskGates, buildQualityFeedback, buildReworkFeedback, compactQuality } from "./verdict-policy.js";
import { computeFailureSignature, isRepeatedFailure, type FailureSignature, type FailureSignatureInput } from "./failure-signature.js";
import { RunBudgetExceededError, type RunBudgetTracker } from "../observability/budget.js";
import type { RunnerEnv } from "./types.js";
import { attemptReferences } from "../runtime/references.js";
import { inlineWithin, spillNote } from "../runtime/spill.js";
import type { AdvisorService } from "./advisor.js";

const DEFAULT_FLAKY_RERUNS = 1;

/** The fixed dependencies of one task execution; assembled once, never mutated. */
interface AttemptScope {
  state: RunState;
  taskState: TaskRunState;
  store: RunStateStore;
  git: GitManager;
  budget: RunBudgetTracker;
  agent: RoleAgentService;
  triage: TriagePolicy | undefined;
  maxAttempts: number;
  signal: AbortSignal | undefined;
}

type TriagePolicy = NonNullable<ReturnType<typeof activeFlow>>["template"]["triage"];

/** What carries from one attempt to the next. */
interface AttemptMemory {
  identicalFailures: number;
  feedback: string;
  lastReworkExperienceIds: string[];
  failureInput: FailureSignatureInput | undefined;
  previousSignature: FailureSignature | undefined;
  architectAdvice: AdvisorVerdict | undefined;
}

/**
 * What to answer when the flow has no model review: the deterministic gates
 * decide alone, and the verdict says so rather than pretending a model read it.
 */
function skippedReview(quality: QualityReport): {
  review: ReviewVerdict;
  test: TestVerdict;
  skipped: true;
} {
  const verdict = quality.passed ? "approve" : "request_changes";
  const summary = quality.passed
    ? "Deterministic quality gates passed; model review is not part of this flow."
    : "Deterministic quality gates failed.";
  return {
    review: { verdict, summary, findings: [] },
    test: { verdict, summary, missingTests: [] },
    skipped: true,
  };
}

/** How much of a failure transcript a worker prompt carries before it is spilled. */
const FEEDBACK_INLINE_CHARS = 4_000;

/**
 * Feedback is the longest thing a retry carries, and the least of it is usually
 * enough to act on. What is kept out becomes a note saying where the rest is.
 */
function inlineFeedback(feedback: string, taskId: string): string {
  const inlined = inlineWithin({
    text: feedback,
    maxChars: FEEDBACK_INLINE_CHARS,
    ref: { kind: "task", id: taskId },
  });
  if (!inlined.spilled) return inlined.head;
  return `${inlined.head}\n${spillNote(inlined.spilled)}`;
}

/** A task cannot run before its worktree and the plan exist. */
function requireInitialized(state: RunState, taskState: TaskRunState): void {
  if (taskState.worktree && state.plan) return;
  throw new Error(`Task '${taskState.task.id}' worktree is not initialized`);
}

function emptyAttemptMemory(): AttemptMemory {
  return {
    identicalFailures: 0,
    feedback: "",
    lastReworkExperienceIds: [],
    failureInput: undefined,
    previousSignature: undefined,
    architectAdvice: undefined,
  };
}

/**
 * Attempt counts persist across resume segments: a task interrupted at attempt N
 * continues at N+1, and a task that already exhausted its rework limit stays
 * blocked instead of being granted a fresh budget.
 */
function firstAttempt(
  reused: "committed" | "rework" | "fresh" | undefined,
  priorAttempts: number,
  maxAttempts: number,
): number {
  const prior = Math.max(priorAttempts, 0);
  if (reused === "rework") return Math.min(prior + 1, maxAttempts);
  return prior > 0 ? prior + 1 : 1;
}

/** Wrap the agent so a task cannot spend more than its share of the run's budget. */
function withTaskBudget(
  taskBudget: TaskBudgetLimits | undefined,
  baseAgent: RoleAgentService,
  taskState: TaskRunState,
): RoleAgentService {
  if (!taskBudget) return baseAgent;
  return new TaskBudgetAgent(
    baseAgent,
    taskState.task.id,
    taskBudget,
    taskState.agentInvocations ?? 0,
    (count) => {
      taskState.agentInvocations = count;
    },
  );
}

/** Whether the attempt cleared every gate it had to clear. */
function taskPassed(
  taskState: TaskRunState,
  quality: QualityReport,
  review: ReviewVerdict,
  test: TestVerdict,
): boolean {
  if (!quality.passed) return false;
  return (
    passesTaskGates(quality, review, test)
    || shouldTrustQualityOverReview(review, test)
    || shouldAcceptDocsDespiteEscalate(taskState.task, review, test)
  );
}

/** The first owned-path violation, or nothing when every change is allowed. */
function ownedPathProblem(
  git: GitManager,
  files: readonly string[],
  ownedPaths: readonly string[],
): string | undefined {
  try {
    git.assertOwnedPaths([...files], [...ownedPaths]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export class TaskAttemptRunner {
  constructor(
    private readonly env: RunnerEnv,
    private readonly advisor: AdvisorService,
  ) {}

  async executeOneTask(
    state: RunState,
    taskState: TaskRunState,
    store: RunStateStore,
    git: GitManager,
    baseAgent: RoleAgentService,
    budget: RunBudgetTracker,
    signal?: AbortSignal,
  ): Promise<void> {
    const scope = this.attemptScope({ state, taskState, store, git, baseAgent, budget, signal });
    const memory = emptyAttemptMemory();
    const startAttempt = await this.resumePoint(scope, memory);
    if (startAttempt === undefined) return;

    for (let attempt = startAttempt; attempt <= scope.maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      if ((await this.decideBeforeRetry(scope, memory, attempt)) === "stop") return;
      taskState.attempts = attempt;
      taskState.status = attempt === 1 ? "working" : "reworking";
      await store.save(state);
      const outcome = await this.runWorkerOnce(scope, memory, attempt);
      if (outcome !== "retry") return;
    }
    await this.blockExhausted(scope, memory);
  }

  /** The fixed dependencies of one task execution, assembled once per call. */
  private attemptScope(input: {
    state: RunState;
    taskState: TaskRunState;
    store: RunStateStore;
    git: GitManager;
    baseAgent: RoleAgentService;
    budget: RunBudgetTracker;
    signal: AbortSignal | undefined;
  }): AttemptScope {
    const { state, taskState, baseAgent } = input;
    requireInitialized(state, taskState);
    return {
      state,
      taskState,
      store: input.store,
      git: input.git,
      budget: input.budget,
      agent: withTaskBudget(this.env.loaded.config.workflow?.taskBudget, baseAgent, taskState),
      triage: (state.flow ? activeFlow(state.flow) : undefined)?.template.triage,
      maxAttempts: state.strategy.maxReworkAttempts + 1,
      signal: input.signal,
    };
  }

  /**
   * The decision taken before an attempt runs: whether a repeated failure has
   * earned an architect's opinion, and whether either the architect or the
   * configured limit says stop. "stop" means the task is already blocked and saved.
   */
  private async decideBeforeRetry(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
  ): Promise<"stop" | "continue"> {
    if (!memory.failureInput) return "continue";
    // Deterministic fork: the same normalized failure twice in a row means a
    // blind retry is unlikely to help, so escalate to the architect.
    const currentSignature = computeFailureSignature(memory.failureInput);
    const repeated = isRepeatedFailure(memory.previousSignature, currentSignature);
    memory.identicalFailures = repeated ? memory.identicalFailures + 1 : 1;
    memory.previousSignature = currentSignature;
    memory.failureInput = undefined;
    memory.architectAdvice = undefined;

    const escalation = await this.escalate(scope, memory, attempt, repeated, currentSignature);
    if (escalation === "stop") return "stop";
    if (this.exceededIdenticalLimit(scope, memory, attempt, repeated, currentSignature)) return "stop";

    this.emitTriage(scope.state, scope.store, {
      taskId: scope.taskState.task.id,
      attempt,
      decision: memory.architectAdvice ? "consult" : "retry",
      source: memory.architectAdvice ? (escalation === "jev" ? "jev" : "advisor") : "signature",
      reason: repeated
        ? `Repeated failure: ${currentSignature.summary}`
        : `New failure: ${currentSignature.summary}`,
    });
    return "continue";
  }

  /**
   * Ask the architect when a failure repeated. Returns "stop" when it says so,
   * otherwise the source that asked, so the triage record can name it.
   */
  private async escalate(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
    repeated: boolean,
    currentSignature: FailureSignature,
  ): Promise<"stop" | "jev" | "advisor" | "none"> {
    const { state, taskState, store, agent, signal } = scope;
    const fork = await this.consultFork(scope, attempt, repeated, currentSignature);
    if (!fork.consult) return "none";
    const escalatedBy = fork.escalatedBy;

    const verdict = await this.advisor.consultAdvisor({
      state,
      store,
      agent,
      trigger: "repeated-failure",
      taskId: taskState.task.id,
      cwd: taskState.worktree!,
      artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "advisor"),
      ...(signal ? { signal } : {}),
      context: {
        trigger: "repeated-failure",
        goal: state.goal,
        planSummary: state.plan!.summary,
        task: taskState.task,
        attempt,
        repeatedFailure: currentSignature.summary,
        repeated,
        ...(escalatedBy ? { escalatedBy } : {}),
        feedback: memory.feedback.slice(-20_000),
        diff: await scope.git.stagedDiff(taskState.worktree!, 60_000, signal).catch(() => ""),
      },
    });
    if (verdict?.recommendation === "stop") {
      this.emitTriage(state, store, {
        taskId: taskState.task.id,
        attempt,
        decision: "stop",
        source: "advisor",
        reason: verdict.summary,
      });
      taskState.status = "blocked";
      taskState.error = `Architect advisor stopped the task after a repeated failure: ${verdict.summary}`;
      await store.save(state);
      return "stop";
    }
    memory.architectAdvice = verdict;
    return escalatedBy ?? "advisor";
  }

  /** Let the fork advisor decide whether an architect is worth consulting at all. */
  private async consultFork(
    scope: AttemptScope,
    attempt: number,
    repeated: boolean,
    currentSignature: FailureSignature,
  ): Promise<{ consult: boolean; escalatedBy: "jev" | undefined }> {
    const { state, taskState, store, signal, maxAttempts } = scope;
    if (!this.env.forkAdvisor || !this.advisor.canConsultAdvisor(state, "repeated-failure")) {
      return { consult: repeated, escalatedBy: undefined };
    }
    const resolution = await this.advisor.decideWithFork(state, store, {
      taskId: taskState.task.id,
      taskTitle: taskState.task.title,
      attempt,
      maxAttempts,
      repeated,
      failureSummary: currentSignature.summary,
      ...(signal ? { signal } : {}),
    });
    return {
      consult: resolution.consult,
      escalatedBy: resolution.consult && !repeated ? "jev" : undefined,
    };
  }

  /** The configured limit on identical failures, unless the architect advised. */
  private exceededIdenticalLimit(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
    repeated: boolean,
    currentSignature: FailureSignature,
  ): boolean {
    const stopAfter = scope.triage?.stopAfterIdenticalFailures;
    if (stopAfter === undefined || !repeated) return false;
    if (memory.identicalFailures < stopAfter || memory.architectAdvice) return false;
    const reason = `The same failure repeated ${memory.identicalFailures} times: ${currentSignature.summary}`;
    this.emitTriage(scope.state, scope.store, {
      taskId: scope.taskState.task.id,
      attempt,
      decision: "stop",
      source: "limit",
      reason,
    });
    scope.taskState.status = "blocked";
    scope.taskState.error = `Stopped after a repeated identical failure: ${currentSignature.summary}`;
    return true;
  }

  /**
   * One attempt: run the worker, run the gates, review, and either commit or record
   * why the next attempt is needed. "retry" leaves the feedback in `memory`.
   */
  private async runWorkerOnce(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
  ): Promise<"passed" | "blocked" | "retry"> {
    try {
      const outcome = await this.attemptWork(scope, memory, attempt);
      return outcome;
    } catch (error) {
      return await this.handleAttemptError(scope, memory, attempt, error);
    }
  }

  /** One worker turn: the experiences it should see, the call, and its profile. */
  private async runWorkerTurn(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
  ): Promise<void> {
    const { state, taskState, agent } = scope;
    const reworkExperiences = await this.loadReworkExperiences(scope, memory, attempt);
    memory.lastReworkExperienceIds = reworkExperiences?.items.map((item) => item.id) ?? [];
    const worker = await agent.runText({
      role: "worker",
      cwd: taskState.worktree!,
      runId: state.id,
      artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "worker"),
      ...(taskState.task.profile ? { profileName: taskState.task.profile } : {}),
      context: {
        goal: state.goal,
        planSummary: state.plan!.summary,
        task: taskState.task,
        attempt,
        feedback: inlineFeedback(memory.feedback, taskState.task.id),
        // Named, not pasted: what this attempt belongs to, and what it is.
        references: attemptReferences({
          runId: state.id,
          goal: state.goal,
          ticketId: state.ticketId,
          task: taskState.task,
        }),
        ...(reworkExperiences ? { verifiedFailureExperiences: reworkExperiences } : {}),
        ...(memory.architectAdvice ? { architectAdvice: memory.architectAdvice } : {}),
      },
    });
    taskState.profile = worker.profileName;
  }

  /** Verified experiences from earlier failures, but only once there is feedback. */
  private async loadReworkExperiences(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
  ) {
    if (attempt === 1 || !memory.feedback) return undefined;
    return await this.env.experience.loadRework(scope.state, scope.store, {
      feedback: memory.feedback,
      taskId: scope.taskState.task.id,
      taskTitle: scope.taskState.task.title,
    });
  }

  private async attemptWork(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
  ): Promise<"passed" | "retry"> {
    const { state, taskState, store, git, agent, budget, signal } = scope;
    const worktree = taskState.worktree!;
    await this.runWorkerTurn(scope, memory, attempt);
    const quality = await this.runTaskQualityGates(
      state,
      taskState,
      worktree,
      store,
      budget,
      attempt,
      signal,
    );
    await git.stage(worktree, signal);
    const files = await git.changedFiles(worktree, signal);
    if (files.length === 0) {
      return await this.rejectAttempt(scope, memory, attempt, quality, {
        feedback: "No repository changes were produced. Implement the assigned task.",
      });
    }
    const owned = ownedPathProblem(git, files, taskState.task.ownedPaths);
    if (owned) {
      return await this.rejectAttempt(scope, memory, attempt, quality, { feedback: owned });
    }

    const diff = await git.stagedDiff(worktree, 160_000, signal);
    const { review, test, skipped } = await this.reviewTaskAttempt(
      state,
      taskState,
      worktree,
      store,
      agent,
      quality,
      files,
      diff,
      attempt,
    );
    if (taskPassed(taskState, quality, review, test)) {
      if (attempt > 1 && memory.lastReworkExperienceIds.length > 0) {
        await this.env.experience.recordSuccess(state, store, memory.lastReworkExperienceIds);
      }
      await this.commitPassedTask(state, taskState, worktree, store, git, signal);
      return "passed";
    }
    if (isHardSpecialistEscalation(review, test) && !quality.passed) {
      throw new Error(`Specialist escalated task: ${review.summary}; ${test.summary}`);
    }
    const feedback = skipped
      ? buildQualityFeedback(quality)
      : buildReworkFeedback(quality, review, test);
    memory.feedback = feedback;
    memory.failureInput = { quality, review, test };
    await this.env.experience.recordAttempt(state, store, taskState, attempt, feedback);
    await store.transition(
      state,
      "reworking",
      `Task ${taskState.task.id} failed gates on attempt ${attempt}`,
    );
    return "retry";
  }

  /** A gate that failed before review: record why and ask for another attempt. */
  private async rejectAttempt(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
    quality: QualityReport,
    input: { feedback: string },
  ): Promise<"retry"> {
    memory.feedback = input.feedback;
    memory.failureInput = { quality, errorMessage: input.feedback };
    await this.env.experience.recordAttempt(
      scope.state,
      scope.store,
      scope.taskState,
      attempt,
      input.feedback,
    );
    return "retry";
  }

  /**
   * A failed attempt that threw. Budget exhaustion and aborts are control-plane
   * signals, never rework feedback, so they stop the loop instead of feeding it.
   */
  private async handleAttemptError(
    scope: AttemptScope,
    memory: AttemptMemory,
    attempt: number,
    error: unknown,
  ): Promise<"blocked" | "retry"> {
    const { state, taskState, store, signal } = scope;
    if (error instanceof RunBudgetExceededError || signal?.aborted) throw error;
    if (error instanceof TaskBudgetExceededError) {
      taskState.status = "blocked";
      taskState.error = error.message;
      await store.save(state);
      return "blocked";
    }
    memory.feedback = error instanceof Error ? error.message : String(error);
    memory.failureInput = { errorMessage: memory.feedback };
    await this.env.experience.recordAttempt(state, store, taskState, attempt, memory.feedback);
    if (memory.feedback.startsWith("Specialist escalated")) {
      taskState.status = "blocked";
      taskState.error = memory.feedback;
      await store.save(state);
      return "blocked";
    }
    return "retry";
  }

  /** Every attempt ran and none passed: block with the last reason. */
  private async blockExhausted(scope: AttemptScope, memory: AttemptMemory): Promise<void> {
    const { state, taskState, store } = scope;
    taskState.status = "blocked";
    taskState.error = `Exceeded ${scope.maxAttempts} attempt(s): ${memory.feedback}`;
    await store.save(state);
  }

  /**
   * Where the attempt numbering starts, given what a resumed task already did.
   * `undefined` means the task is finished or already blocked and the caller stops.
   */
  private async resumePoint(
    scope: AttemptScope,
    memory: AttemptMemory,
  ): Promise<number | undefined> {
    const { state, taskState, store, git, agent, signal } = scope;
    const reused = await this.tryFinishAlreadyPassedTask(state, taskState, store, git, agent, signal);
    if (reused === "committed") return undefined;
    if (reused === "rework") {
      memory.feedback = taskState.error ?? "Previous review requested changes";
    }
    const startAttempt = firstAttempt(reused, taskState.attempts, scope.maxAttempts);
    if (startAttempt <= scope.maxAttempts) return startAttempt;
    await this.blockWithoutBudget(scope);
    return undefined;
  }

  /** Refuse to start when the task resumed with no attempts left. */
  private async refuseWithoutBudget(scope: AttemptScope, startAttempt: number): Promise<boolean> {
    if (startAttempt <= scope.maxAttempts) return false;
    await this.blockWithoutBudget(scope);
    return true;
  }

  /** The task resumed with no attempts left: it was already out of budget. */
  private async blockWithoutBudget(scope: AttemptScope): Promise<void> {
    const { state, taskState, store } = scope;
    const prior = Math.max(taskState.attempts, 0);
    taskState.status = "blocked";
    taskState.error = `Rework attempts exhausted: ${prior} attempt(s) against limit ${state.strategy.maxReworkAttempts}`;
    await store.save(state);
  }


  flakyReruns(): number {
    return this.env.loaded.config.workflow?.flakyReruns ?? DEFAULT_FLAKY_RERUNS;
  }

  noteFlaky(
    state: RunState,
    store: RunStateStore,
    quality: QualityReport,
    taskId?: string,
  ): void {
    if (!quality.flaky?.length) return;
    store.emit(state.id, "quality.flaky", {
      ...(taskId ? { taskId } : {}),
      commands: quality.flaky.map((spec) => [spec.command, ...spec.args].join(" ")),
      reruns: quality.reruns ?? 1,
    });
  }

  emitTriage(state: RunState, store: RunStateStore, event: TriageEvent): void {
    if (state.flow) store.emit(state.id, "flow.triage", event);
  }

  async canReusePassedWorktree(taskState: TaskRunState): Promise<boolean> {
    return Boolean(
      taskState.quality?.passed &&
        taskState.branch &&
        taskState.worktree &&
        (await pathExists(taskState.worktree)),
    );
  }

  async tryFinishAlreadyPassedTask(
    state: RunState,
    taskState: TaskRunState,
    store: RunStateStore,
    git: GitManager,
    agent: RoleAgentService,
    signal?: AbortSignal,
  ): Promise<"committed" | "rework" | "fresh"> {
    if (!(await this.canReusePassedWorktree(taskState)) || !taskState.worktree) {
      return "fresh";
    }
    if (taskState.commit) {
      taskState.status = "passed";
      await store.save(state);
      return "committed";
    }
    const leftover = await this.stagedLeftover(state, taskState, store, git, signal);
    if (!leftover) return "fresh";
    const { quality, files, diff } = leftover;
    // The earlier review is consulted before a new one runs — and before a new one
    // overwrites it. A resumed task that already cleared the gates is not reviewed
    // a second time.
    if (this.earlierReviewPasses(taskState, quality)) {
      await this.commitPassedTask(state, taskState, taskState.worktree, store, git, signal);
      return "committed";
    }
    const { review, test, skipped } = await this.reviewTaskAttempt(
      state,
      taskState,
      taskState.worktree,
      store,
      agent,
      quality,
      files,
      diff,
      Math.max(taskState.attempts, 1),
    );
    if (taskPassed(taskState, quality, review, test)) {
      await this.commitPassedTask(state, taskState, taskState.worktree, store, git, signal);
      return "committed";
    }
    if (isHardSpecialistEscalation(review, test) && !quality.passed) return "fresh";
    await this.recordRework(state, taskState, store, quality, review, test, skipped);
    return "rework";
  }

  /** Whether the verdicts this task already carries clear its gates. */
  private earlierReviewPasses(taskState: TaskRunState, quality: QualityReport): boolean {
    if (!taskState.review || !taskState.test) return false;
    return taskPassed(taskState, quality, taskState.review, taskState.test);
  }

  /** Keep why a resumed attempt needs rework, so the next attempt can read it. */
  private async recordRework(
    state: RunState,
    taskState: TaskRunState,
    store: RunStateStore,
    quality: QualityReport,
    review: ReviewVerdict,
    test: TestVerdict,
    skipped: boolean,
  ): Promise<void> {
    taskState.status = "reworking";
    taskState.error = skipped
      ? buildQualityFeedback(quality)
      : buildReworkFeedback(quality, review, test);
    await store.save(state);
  }

  /**
   * The work a resumed task already produced: its staged changes and the review
   * they earned. Nothing to reuse — no changes, or changes outside the task's
   * owned paths — means the attempt starts fresh.
   */
  private async stagedLeftover(
    state: RunState,
    taskState: TaskRunState,
    store: RunStateStore,
    git: GitManager,
    signal: AbortSignal | undefined,
  ): Promise<undefined | { quality: QualityReport; files: string[]; diff: string }> {
    const worktree = taskState.worktree!;
    await git.stage(worktree, signal);
    const files = await git.changedFiles(worktree, signal);
    if (files.length === 0) return undefined;
    if (ownedPathProblem(git, files, taskState.task.ownedPaths)) return undefined;
    const diff = await git.stagedDiff(worktree, 160_000, signal);
    return { quality: taskState.quality!, files, diff };
  }


  async prepareWorktreeDependencies(
    worktree: string,
    signal: AbortSignal | undefined,
    maxOutputBytes: number | undefined,
  ): Promise<void> {
    await ensureWorktreeNodeModules(worktree, {
      timeoutSeconds: this.env.loaded.config.quality.commandTimeoutSeconds,
      ...(signal ? { signal } : {}),
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
    });
  }

  async runTaskQualityGates(
    state: RunState,
    taskState: TaskRunState,
    worktree: string,
    store: RunStateStore,
    budget: RunBudgetTracker,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<QualityReport> {
    const projectCommands = taskUsesProjectQualityGates(taskState.task)
      ? this.env.loaded.config.quality.commands
      : [];
    const commands = deduplicateCommands([
      ...projectCommands,
      ...taskState.task.acceptanceCommands,
    ]);
    const quality = await runQualityWithRerun(
      worktree,
      commands,
      this.env.loaded.config.quality.commandTimeoutSeconds,
      store.artifactDirectory(
        state.id,
        taskArtifactKey(state, taskState.task.id, attempt, "quality"),
      ),
      signal,
      { maxOutputBytes: state.strategy.maxProcessOutputBytes },
      this.flakyReruns(),
    );
    this.noteFlaky(state, store, quality, taskState.task.id);
    await budget.recordQuality(quality);
    taskState.quality = quality;
    return quality;
  }

  async reviewTaskAttempt(
    state: RunState,
    taskState: TaskRunState,
    worktree: string,
    store: RunStateStore,
    agent: RoleAgentService,
    quality: QualityReport,
    changedFiles: string[],
    diff: string,
    attempt: number,
  ): Promise<{ review: ReviewVerdict; test: TestVerdict; skipped: boolean }> {
    const flow = state.flow ? activeFlow(state.flow) : undefined;
    if (!taskStepEnabled(flow, "review") && !taskStepEnabled(flow, "test")) {
      return skippedReview(quality);
    }
    await store.transition(
      state,
      "reviewing-testing",
      `Reviewing and testing task ${taskState.task.id}, attempt ${attempt}`,
    );
    let [review, test] = await Promise.all([
      agent.runStructured({
        role: "reviewer",
        cwd: worktree,
        runId: state.id,
        artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "review"),
        context: {
          goal: state.goal,
          planSummary: state.plan!.summary,
          task: taskState.task,
          changedFiles,
          diff,
        },
        schema: reviewVerdictSchema,
        jsonSchema: reviewVerdictJsonSchema,
      }),
      agent.runStructured({
        role: "tester",
        cwd: worktree,
        runId: state.id,
        artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "test"),
        context: {
          goal: state.goal,
          task: taskState.task,
          changedFiles,
          diff,
          quality: compactQuality(quality),
        },
        schema: testVerdictSchema,
        jsonSchema: testVerdictJsonSchema,
      }),
    ]);
    if (isPlaceholderVerdict(review.value.verdict, review.value.summary) || isPlaceholderVerdict(test.value.verdict, test.value.summary)) {
      const retryKey = `${taskArtifactKey(state, taskState.task.id, attempt, "review")}-complete`;
      const [reviewRetry, testRetry] = await Promise.all([
        isPlaceholderVerdict(review.value.verdict, review.value.summary)
          ? agent.runStructured({
              role: "reviewer",
              cwd: worktree,
              runId: state.id,
              artifactKey: retryKey,
              context: {
                goal: state.goal,
                planSummary: state.plan!.summary,
                task: taskState.task,
                changedFiles,
                diff,
                previousIncompleteVerdict: review.value,
                instruction:
                  "Your previous verdict was a placeholder. Inspect the diff and return a final approve/request_changes/escalate verdict now. Do not say you are still reading.",
              },
              schema: reviewVerdictSchema,
              jsonSchema: reviewVerdictJsonSchema,
            })
          : review,
        isPlaceholderVerdict(test.value.verdict, test.value.summary)
          ? agent.runStructured({
              role: "tester",
              cwd: worktree,
              runId: state.id,
              artifactKey: `${taskArtifactKey(state, taskState.task.id, attempt, "test")}-complete`,
              context: {
                goal: state.goal,
                task: taskState.task,
                changedFiles,
                diff,
                quality: compactQuality(quality),
                previousIncompleteVerdict: test.value,
                instruction:
                  "Your previous verdict was a placeholder. Judge the acceptance commands and return a final approve/request_changes/escalate verdict now. Do not say you are still reading.",
              },
              schema: testVerdictSchema,
              jsonSchema: testVerdictJsonSchema,
            })
          : test,
      ]);
      review = reviewRetry;
      test = testRetry;
    }
    taskState.review = review.value;
    taskState.test = test.value;
    await store.save(state);
    return { review: review.value, test: test.value, skipped: false };
  }

  async commitPassedTask(
    state: RunState,
    taskState: TaskRunState,
    worktree: string,
    store: RunStateStore,
    git: GitManager,
    signal?: AbortSignal,
  ): Promise<void> {
    await git.stage(worktree, signal);
    const finalFiles = await git.changedFiles(worktree, signal);
    git.assertOwnedPaths(finalFiles, taskState.task.ownedPaths);
    taskState.commit = await git.commit(
      worktree,
      `agent: ${taskState.task.id} ${taskState.task.title}`,
      signal,
    );
    taskState.status = "passed";
    await store.save(state);
  }
}
