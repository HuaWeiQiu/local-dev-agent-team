import type { RoleAgentService } from "../agents/service.js";
import { activeFlow, taskStepEnabled, type TriageEvent } from "../flow/index.js";
import { reviewVerdictSchema, testVerdictSchema, type AdvisorVerdict, type ReviewVerdict, type TestVerdict } from "../domain/contracts.js";
import { reviewVerdictJsonSchema, testVerdictJsonSchema } from "../domain/json-schemas.js";
import { taskUsesProjectQualityGates } from "../domain/plan.js";
import { type GitManager } from "../git/manager.js";
import { ensureWorktreeNodeModules } from "../quality/install.js";
import { runQualityWithRerun } from "../quality/flaky.js";
import { deduplicateCommands, type QualityReport } from "../quality/run.js";
import { TaskBudgetAgent, TaskBudgetExceededError } from "../reliability/task-budget.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState, TaskRunState } from "../state/types.js";
import { pathExists, taskArtifactKey } from "./state-helpers.js";
import { isPlaceholderVerdict, shouldAcceptDocsDespiteEscalate, isHardSpecialistEscalation, shouldTrustQualityOverReview, passesTaskGates, buildQualityFeedback, buildReworkFeedback, compactQuality } from "./verdict-policy.js";
import { computeFailureSignature, isRepeatedFailure, type FailureSignature, type FailureSignatureInput } from "./failure-signature.js";
import { RunBudgetExceededError, type RunBudgetTracker } from "../observability/budget.js";
import type { RunnerEnv } from "./types.js";
import type { AdvisorService } from "./advisor.js";

const DEFAULT_FLAKY_RERUNS = 1;

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
    if (!taskState.worktree || !state.plan) {
      throw new Error(`Task '${taskState.task.id}' worktree is not initialized`);
    }
    const taskBudget = this.env.loaded.config.workflow?.taskBudget;
    const agent: RoleAgentService = taskBudget
      ? new TaskBudgetAgent(
          baseAgent,
          taskState.task.id,
          taskBudget,
          taskState.agentInvocations ?? 0,
          (count) => {
            taskState.agentInvocations = count;
          },
        )
      : baseAgent;
    const triagePolicy = (state.flow ? activeFlow(state.flow) : undefined)?.template.triage;
    let identicalFailures = 0;
    const maxAttempts = state.strategy.maxReworkAttempts + 1;
    let feedback = "";
    let lastReworkExperienceIds: string[] = [];
    let failureInput: FailureSignatureInput | undefined;
    let previousSignature: FailureSignature | undefined;
    let architectAdvice: AdvisorVerdict | undefined;
    const reused = await this.tryFinishAlreadyPassedTask(
      state,
      taskState,
      store,
      git,
      agent,
      signal,
    );
    if (reused === "committed") {
      return;
    }
    if (reused === "rework") {
      feedback = taskState.error ?? "Previous review requested changes";
    }
    // Attempt counts persist across resume segments: a task interrupted at
    // attempt N continues at N+1, and a task that already exhausted its
    // rework limit stays blocked instead of being granted a fresh budget.
    const priorAttempts = Math.max(taskState.attempts, 0);
    const startAttempt =
      reused === "rework"
        ? Math.min(priorAttempts + 1, maxAttempts)
        : priorAttempts > 0
          ? priorAttempts + 1
          : 1;
    if (startAttempt > maxAttempts) {
      taskState.status = "blocked";
      taskState.error = `Rework attempts exhausted: ${priorAttempts} attempt(s) against limit ${state.strategy.maxReworkAttempts}`;
      await store.save(state);
      return;
    }

    for (let attempt = startAttempt; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      if (failureInput) {
        // Deterministic fork: the same normalized failure twice in a row means
        // a blind retry is unlikely to help, so escalate to the architect.
        const currentSignature = computeFailureSignature(failureInput);
        const repeated = isRepeatedFailure(previousSignature, currentSignature);
        identicalFailures = repeated ? identicalFailures + 1 : 1;
        previousSignature = currentSignature;
        failureInput = undefined;
        architectAdvice = undefined;
        let consult = repeated;
        let escalatedBy: "jev" | undefined;
        if (this.env.forkAdvisor && this.advisor.canConsultAdvisor(state, "repeated-failure")) {
          const resolution = await this.advisor.decideWithFork(state, store, {
            taskId: taskState.task.id,
            taskTitle: taskState.task.title,
            attempt,
            maxAttempts,
            repeated,
            failureSummary: currentSignature.summary,
            ...(signal ? { signal } : {}),
          });
          consult = resolution.consult;
          if (consult && !repeated) {
            escalatedBy = "jev";
          }
        }
        if (consult) {
          const verdict = await this.advisor.consultAdvisor({
            state,
            store,
            agent,
            trigger: "repeated-failure",
            taskId: taskState.task.id,
            cwd: taskState.worktree,
            artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "advisor"),
            ...(signal ? { signal } : {}),
            context: {
              trigger: "repeated-failure",
              goal: state.goal,
              planSummary: state.plan.summary,
              task: taskState.task,
              attempt,
              repeatedFailure: currentSignature.summary,
              repeated,
              ...(escalatedBy ? { escalatedBy } : {}),
              feedback: feedback.slice(-20_000),
              diff: await git.stagedDiff(taskState.worktree, 60_000, signal).catch(() => ""),
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
            return;
          }
          architectAdvice = verdict;
        }
        const stopAfter = triagePolicy?.stopAfterIdenticalFailures;
        if (stopAfter !== undefined && repeated && identicalFailures >= stopAfter && !architectAdvice) {
          const reason = `The same failure repeated ${identicalFailures} times: ${currentSignature.summary}`;
          this.emitTriage(state, store, {
            taskId: taskState.task.id,
            attempt,
            decision: "stop",
            source: "limit",
            reason,
          });
          taskState.status = "blocked";
          taskState.error = `Stopped after a repeated identical failure: ${currentSignature.summary}`;
          await store.save(state);
          return;
        }
        this.emitTriage(state, store, {
          taskId: taskState.task.id,
          attempt,
          decision: architectAdvice ? "consult" : "retry",
          source: architectAdvice ? (escalatedBy === "jev" ? "jev" : "advisor") : "signature",
          reason: repeated
            ? `Repeated failure: ${currentSignature.summary}`
            : `New failure: ${currentSignature.summary}`,
        });
      }
      taskState.attempts = attempt;
      taskState.status = attempt === 1 ? "working" : "reworking";
      await store.save(state);
      try {
        const reworkExperiences =
          attempt > 1 && feedback
            ? await this.env.experience.loadRework(state, store, {
                feedback,
                taskId: taskState.task.id,
                taskTitle: taskState.task.title,
              })
            : undefined;
        lastReworkExperienceIds = reworkExperiences?.items.map((item) => item.id) ?? [];
        const worker = await agent.runText({
          role: "worker",
          cwd: taskState.worktree,
          runId: state.id,
          artifactKey: taskArtifactKey(state, taskState.task.id, attempt, "worker"),
          ...(taskState.task.profile ? { profileName: taskState.task.profile } : {}),
          context: {
            goal: state.goal,
            planSummary: state.plan.summary,
            task: taskState.task,
            attempt,
            feedback,
            ...(reworkExperiences ? { verifiedFailureExperiences: reworkExperiences } : {}),
            ...(architectAdvice ? { architectAdvice } : {}),
          },
        });
        taskState.profile = worker.profileName;

        const quality = await this.runTaskQualityGates(
          state,
          taskState,
          taskState.worktree,
          store,
          budget,
          attempt,
          signal,
        );

        await git.stage(taskState.worktree, signal);
        const files = await git.changedFiles(taskState.worktree, signal);
        if (files.length === 0) {
          feedback = "No repository changes were produced. Implement the assigned task.";
          failureInput = { quality, errorMessage: feedback };
          await this.env.experience.recordAttempt(state, store, taskState, attempt, feedback);
          continue;
        }
        try {
          git.assertOwnedPaths(files, taskState.task.ownedPaths);
        } catch (error) {
          feedback = error instanceof Error ? error.message : String(error);
          failureInput = { quality, errorMessage: feedback };
          await this.env.experience.recordAttempt(state, store, taskState, attempt, feedback);
          continue;
        }
        const diff = await git.stagedDiff(taskState.worktree, 160_000, signal);
        const { review, test, skipped } = await this.reviewTaskAttempt(
          state,
          taskState,
          taskState.worktree,
          store,
          agent,
          quality,
          files,
          diff,
          attempt,
        );

        if (
          quality.passed
          && (
            passesTaskGates(quality, review, test)
            || shouldTrustQualityOverReview(review, test)
            || shouldAcceptDocsDespiteEscalate(taskState.task, review, test)
          )
        ) {
          if (attempt > 1 && lastReworkExperienceIds.length > 0) {
            await this.env.experience.recordSuccess(state, store, lastReworkExperienceIds);
          }
          await this.commitPassedTask(state, taskState, taskState.worktree, store, git, signal);
          return;
        }
        if (isHardSpecialistEscalation(review, test) && !quality.passed) {
          throw new Error(
            `Specialist escalated task: ${review.summary}; ${test.summary}`,
          );
        }
        feedback = skipped
          ? buildQualityFeedback(quality)
          : buildReworkFeedback(quality, review, test);
        failureInput = { quality, review, test };
        await this.env.experience.recordAttempt(state, store, taskState, attempt, feedback);
        await store.transition(
          state,
          "reworking",
          `Task ${taskState.task.id} failed gates on attempt ${attempt}`,
        );
      } catch (error) {
        if (error instanceof RunBudgetExceededError || signal?.aborted) {
          // Budget exhaustion and aborts are control-plane signals, not
          // rework feedback; never spin them into further attempts.
          throw error;
        }
        if (error instanceof TaskBudgetExceededError) {
          taskState.status = "blocked";
          taskState.error = error.message;
          await store.save(state);
          return;
        }
        feedback = error instanceof Error ? error.message : String(error);
        failureInput = { errorMessage: feedback };
        await this.env.experience.recordAttempt(state, store, taskState, attempt, feedback);
        if (feedback.startsWith("Specialist escalated")) {
          taskState.status = "blocked";
          taskState.error = feedback;
          await store.save(state);
          return;
        }
      }
    }

    taskState.status = "blocked";
    taskState.error = `Exceeded ${maxAttempts} attempt(s): ${feedback}`;
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
    await git.stage(taskState.worktree, signal);
    const files = await git.changedFiles(taskState.worktree, signal);
    if (files.length === 0) {
      return "fresh";
    }
    try {
      git.assertOwnedPaths(files, taskState.task.ownedPaths);
    } catch {
      return "fresh";
    }
    const attempt = Math.max(taskState.attempts, 1);
    const diff = await git.stagedDiff(taskState.worktree, 160_000, signal);
    const quality = taskState.quality!;
    if (
      taskState.review &&
      taskState.test &&
      (passesTaskGates(quality, taskState.review, taskState.test) ||
        shouldTrustQualityOverReview(taskState.review, taskState.test) ||
        shouldAcceptDocsDespiteEscalate(taskState.task, taskState.review, taskState.test))
    ) {
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
      attempt,
    );
    if (
      quality.passed &&
      (passesTaskGates(quality, review, test) ||
        shouldTrustQualityOverReview(review, test) ||
        shouldAcceptDocsDespiteEscalate(taskState.task, review, test))
    ) {
      await this.commitPassedTask(state, taskState, taskState.worktree, store, git, signal);
      return "committed";
    }
    if (isHardSpecialistEscalation(review, test) && !quality.passed) {
      return "fresh";
    }
    taskState.status = "reworking";
    taskState.error = skipped
      ? buildQualityFeedback(quality)
      : buildReworkFeedback(quality, review, test);
    await store.save(state);
    return "rework";
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
      // The quick template has no model review; deterministic gates decide alone.
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
