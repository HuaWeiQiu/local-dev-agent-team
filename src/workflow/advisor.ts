import type { RoleAgentService } from "../agents/service.js";
import { advisorVerdictSchema, type AdvisorVerdict } from "../domain/contracts.js";
import { advisorVerdictJsonSchema } from "../domain/json-schemas.js";
import { type RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { isBudgetExceededError } from "./state-helpers.js";
import { resolveConsultation, type ConsultationResolution, type JevDecision, type JevDecisionInput } from "../jev/policy.js";
import { RunBudgetExceededError } from "../observability/budget.js";
import type { AdvisorTrigger } from "../config/schema.js";
import type { RunnerEnv } from "./types.js";

export class AdvisorService {
  constructor(
    private readonly env: RunnerEnv,
  ) {}

  canConsultAdvisor(state: RunState, trigger: AdvisorTrigger): boolean {
    const advisor = state.strategy.advisor;
    return Boolean(
      advisor?.enabled &&
        advisor.triggers.includes(trigger) &&
        (state.advisorConsultations ?? 0) < advisor.maxConsultationsPerRun,
    );
  }

  /**
   * Ask the local fork model whether to escalate now. Advisory only: it can
   * bring the architect forward, never skip a required consultation or change any check result, and
   * any failure or low confidence keeps the deterministic decision.
   */
  async decideWithFork(
    state: RunState,
    store: RunStateStore,
    input: JevDecisionInput & { signal?: AbortSignal },
  ): Promise<ConsultationResolution> {
    const { signal, ...request } = input;
    const startedAt = Date.now();
    let decision: JevDecision | undefined;
    try {
      decision = await this.env.forkAdvisor?.decide(request, signal);
    } catch {
      decision = undefined;
    }
    signal?.throwIfAborted();
    const minConfidence = this.env.loaded.config.jev?.minConfidence ?? 0.8;
    const resolution = resolveConsultation({
      repeated: request.repeated,
      jev: decision,
      minConfidence,
    });
    store.emit(state.id, "run.jev.decided", {
      taskId: request.taskId,
      attempt: request.attempt,
      repeated: request.repeated,
      ...(decision
        ? { decision: decision.decision, confidence: decision.confidence }
        : {}),
      source: resolution.source,
      consult: resolution.consult,
      changedOutcome: resolution.consult !== request.repeated,
      reason: resolution.reason,
      latencyMs: Date.now() - startedAt,
    });
    return resolution;
  }

  /**
   * Consult the on-call architect. Read-only: the verdict is advice injected
   * into later context and never overrides deterministic checks. Returns
   * undefined when disabled, out of budget, or when the consultation failed
   * (fail-open). Budget exhaustion and aborts are never swallowed.
   */
  async consultAdvisor(options: {
    state: RunState;
    store: RunStateStore;
    agent: RoleAgentService;
    trigger: AdvisorTrigger;
    taskId?: string;
    cwd: string;
    artifactKey: string;
    context: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<AdvisorVerdict | undefined> {
    const { state, store, agent, trigger, taskId } = options;
    const advisor = state.strategy.advisor;
    if (!advisor?.enabled || !advisor.triggers.includes(trigger)) {
      return undefined;
    }
    const used = state.advisorConsultations ?? 0;
    if (used >= advisor.maxConsultationsPerRun) {
      store.emit(state.id, "run.advisor.skipped", {
        trigger,
        ...(taskId ? { taskId } : {}),
        reason: "consultation-limit",
        used,
        limit: advisor.maxConsultationsPerRun,
      });
      return undefined;
    }
    // Count before invoking so an interrupted consultation still spends quota
    // and resume cannot loop on it indefinitely.
    state.advisorConsultations = used + 1;
    await store.save(state);
    try {
      const response = await agent.runStructured({
        role: "architect",
        promptKey: "architect-advisor",
        cwd: options.cwd,
        runId: state.id,
        artifactKey: options.artifactKey,
        ...(advisor.profile ? { profileName: advisor.profile } : {}),
        context: options.context,
        schema: advisorVerdictSchema,
        jsonSchema: advisorVerdictJsonSchema,
      });
      store.emit(state.id, "run.advisor.consulted", {
        trigger,
        ...(taskId ? { taskId } : {}),
        profile: response.profileName,
        usedFallback: response.usedFallback,
        recommendation: response.value.recommendation,
        summary: response.value.summary,
        used: used + 1,
        limit: advisor.maxConsultationsPerRun,
      });
      return response.value;
    } catch (error) {
      if (error instanceof RunBudgetExceededError || isBudgetExceededError(error)) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      store.emit(state.id, "run.advisor.failed", {
        trigger,
        ...(taskId ? { taskId } : {}),
        error: message.slice(0, 500),
      });
      return undefined;
    }
  }
}
