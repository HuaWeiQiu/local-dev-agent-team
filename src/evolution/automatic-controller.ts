import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ProfiledAgentService } from "../agents/service.js";
import type { AutomaticEvolutionConfig, NamedStrategy } from "../config/schema.js";
import type { LoadedConfig } from "../config/load.js";
import {
  automaticCandidateImproved,
  automaticRunEvidenceItems,
  automaticStrategyCandidateSchema,
  projectRunOutcome,
  type AutomaticEvolutionCycle,
  type AutomaticEvolutionSnapshot,
  type AutomaticOutcomeAggregate,
  type AutomaticStrategyCandidate,
} from "./automation.js";
import { EvolutionApplicationCoordinator } from "./application.js";
import { AutomaticEvolutionStateStore } from "./automatic-state.js";
import {
  computeCandidateDigest,
  EVOLUTION_DOMAIN_VERSION,
  type EvolutionCandidate,
  type EvolutionPolicy,
  type EvolutionProposal,
} from "./domain.js";
import { RunStateStore } from "../state/store.js";
import type { RunState } from "../state/types.js";
import { createExecutionDeadline, RunBudgetTracker } from "../observability/budget.js";
import { StrategyBlueprintCatalog } from "../strategies/catalog.js";
import { resolveStrategy, type ResolvedStrategy } from "../strategies/resolve.js";
import { createRunId } from "../workflow/id.js";
import { GitManager } from "../git/manager.js";
import {
  classifyError,
  ProviderFailureError,
  RoleProfileChainError,
  type ProviderFailureClassification,
} from "../providers/failure.js";
import {
  computeSuiteDigest,
  scoreEvaluationSuite,
} from "../evaluation/domain.js";
import {
  requireEvaluationSuite,
  resolveEvaluationSuite,
} from "../evaluation/resolve.js";
import {
  getInventory,
  loadDesktopSettings,
  mergeRoleDefaults,
  type RoleBinding,
} from "../desktop/settings.js";

export type AutomaticEvolutionErrorCode =
  | "AUTOMATION_DISABLED"
  | "AUTOMATION_RUNNING"
  | "AUTOMATION_NOT_RUNNING"
  | "AUTOMATION_CYCLE_LIMIT"
  | "AUTOMATION_TARGET_CONFLICT"
  | "AUTOMATION_BUDGET_EXPANSION"
  | "AUTOMATION_COMMAND_CONFLICT";

export class AutomaticEvolutionError extends Error {
  constructor(
    readonly code: AutomaticEvolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AutomaticEvolutionError";
  }
}

/** Start request issued by the controller for one isolated evaluation run. */
export interface AutomaticEvolutionRunRequest {
  readonly goal: string;
  readonly strategy: string;
  readonly profileOverrides: Record<string, string>;
  readonly roleBindings?: Record<string, RoleBinding>;
}

/**
 * Run session owned by the host for the duration of one automation loop.
 * The server layer's `EvolutionAutomationSession` satisfies this structurally.
 */
export interface AutomaticEvolutionRunSession {
  start(
    request: AutomaticEvolutionRunRequest,
    idempotencyKey?: string,
  ): { runId: string; deduplicated: boolean };
  cancel(runId: string): Promise<boolean>;
  beginTargetMutation(): () => void;
  release(): void;
}

/** Command-idempotency event log required by the controller. */
export interface AutomaticEvolutionCommandEvents {
  claimCommand(
    key: string,
    requestHash: string,
    response: unknown,
  ): { claimed: boolean; response: unknown };
  releaseCommand(key: string, requestHash: string): void;
}

/**
 * Host capabilities the controller binds to at construction. The server
 * layer's RunSupervisor satisfies this interface structurally and supplies
 * session binding plus supervisor ownership acquisition; the evolution layer
 * never imports the server.
 */
export interface AutomaticEvolutionHost {
  readonly id: string;
  readonly events: AutomaticEvolutionCommandEvents;
  beginAutomationSession(): AutomaticEvolutionRunSession;
  beginEvolutionMutation(): () => void;
  wait(runId: string): Promise<RunState | undefined>;
  get(runId: string): Promise<RunState | undefined>;
}

export interface AutomaticEvolutionDependencies {
  proposeCandidate?: (
    context: AutomaticProposalContext,
    signal: AbortSignal,
  ) => Promise<AutomaticStrategyCandidate>;
  now?: () => number;
  createSessionId?: () => string;
  /** Override home dir for desktop settings / CLI inventory lookup (tests). */
  desktopHome?: string;
}

export interface AutomaticProposalContext {
  project: string;
  cycle: number;
  maxCycles: number;
  targetStrategy: string;
  incumbentStrategy: string;
  incumbentScore: number;
  incumbentDefinition: NamedStrategy;
  previousCycles: Array<{
    cycle: number;
    scoreDelta: number;
    decision: "promoted" | "rejected";
  }>;
  constraints: {
    evaluationRepeats: number;
    minimumScoreDelta: number;
    maxConsecutiveNoImprovement: number;
    budgetsMustNotExceedIncumbent: true;
  };
}

export class AutomaticEvolutionController {
  private readonly config: AutomaticEvolutionConfig;
  private readonly now: () => number;
  private readonly createSessionId: () => string;
  private readonly proposeCandidate: AutomaticEvolutionDependencies["proposeCandidate"];
  private readonly desktopHome: string | undefined;
  private readonly artifactStore: RunStateStore;
  private readonly stateStore: AutomaticEvolutionStateStore;
  private state: AutomaticEvolutionSnapshot;
  private loop: Promise<void> | undefined;
  private abortController: AbortController | undefined;
  private session: AutomaticEvolutionRunSession | undefined;
  /** Resolved once per loop; undefined = 未启用或本机无可用全局默认 */
  private globalRoleBindings: Record<string, RoleBinding> | null | undefined;

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly coordinator: EvolutionApplicationCoordinator,
    private readonly strategies: StrategyBlueprintCatalog,
    private readonly host: AutomaticEvolutionHost,
    dependencies: AutomaticEvolutionDependencies = {},
  ) {
    this.config = loaded.config.evolution.automatic;
    this.now = dependencies.now ?? Date.now;
    this.createSessionId = dependencies.createSessionId ?? randomUUID;
    this.proposeCandidate = dependencies.proposeCandidate;
    this.desktopHome = dependencies.desktopHome;
    this.artifactStore = new RunStateStore(
      path.resolve(loaded.root, loaded.config.project.stateDirectory, "runs"),
    );
    this.stateStore = new AutomaticEvolutionStateStore(
      path.resolve(loaded.root, loaded.config.project.stateDirectory, "evolution"),
    );
    this.state = this.initialState();
  }

  snapshot(): AutomaticEvolutionSnapshot {
    return structuredClone(this.state);
  }

  async wait(): Promise<AutomaticEvolutionSnapshot> {
    await this.loop;
    return this.snapshot();
  }

  async restoreRuntimeDefault(): Promise<void> {
    const control = await this.coordinator.readControlSnapshot();
    await this.cleanupAutomaticShadows(control.catalog.proposals);
    const pointer = control.catalog.activeProposals.find(
      (entry) =>
        entry.target.kind === "strategy-blueprint" &&
        entry.target.name === this.config.targetStrategy,
    );
    const proposal = pointer
      ? control.catalog.proposals.find((entry) => entry.id === pointer.proposalId)
      : undefined;
    const application = proposal
      ? control.application.applications.find((entry) => entry.proposalId === proposal.id)
      : undefined;
    const target = this.strategies.customDefinition(this.config.targetStrategy);
    if (
      proposal?.evaluation?.source === "server-automatic-run-evaluation-v1" &&
      proposal.candidate.kind === "strategy-blueprint" &&
      application?.afterTargetDigest &&
      target &&
      isDeepStrictEqual(target, proposal.candidate.definition)
    ) {
      this.strategies.setRuntimeDefault(this.config.targetStrategy);
    }
  }

  /**
   * 控制服务重启后恢复最近一次评测记录；损坏的落盘数据被丢弃为 null，
   * 不阻断启动。新一轮 start() 会保留该记录，直到新评测完成时刷新。
   */
  async restoreLastEvaluation(): Promise<void> {
    const record = await this.stateStore.loadLastEvaluation();
    if (record) {
      this.state.lastEvaluation = record;
      this.touch();
    }
  }

  start(
    requestedMaxCycles?: number,
    commandId: string = randomUUID(),
    operator = "system:local-automation",
  ): AutomaticEvolutionSnapshot {
    if (!this.config.enabled) {
      throw new AutomaticEvolutionError(
        "AUTOMATION_DISABLED",
        "Automatic evolution is disabled in agent-team.yaml",
      );
    }
    const maxCycles = requestedMaxCycles ?? this.config.maxCycles;
    if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > this.config.maxCycles) {
      throw new AutomaticEvolutionError(
        "AUTOMATION_CYCLE_LIMIT",
        `Automatic evolution cycles must be between 1 and configured maxCycles ${this.config.maxCycles}`,
      );
    }
    const sessionId = this.createSessionId();
    const idempotencyKey = `evolution-automation:start:${commandId}`;
    const requestHash = automaticStartRequestHash(maxCycles, operator);
    const claim = (() => {
      try {
        return this.host.events.claimCommand(idempotencyKey, requestHash, {
          sessionId,
          maxCycles,
          operator,
        });
      } catch (error) {
        throw new AutomaticEvolutionError(
          "AUTOMATION_COMMAND_CONFLICT",
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    if (!claim.claimed) {
      const replay = automaticStartResponse(claim.response, commandId);
      if (this.state.sessionId === replay.sessionId) return this.snapshot();
      throw new AutomaticEvolutionError(
        "AUTOMATION_COMMAND_CONFLICT",
        `Automatic evolution command '${commandId}' was already accepted by session '${replay.sessionId}'`,
      );
    }
    if (this.loop) {
      this.host.events.releaseCommand(idempotencyKey, requestHash);
      throw new AutomaticEvolutionError("AUTOMATION_RUNNING", "Automatic evolution is already running");
    }
    let session: AutomaticEvolutionRunSession;
    try {
      session = this.host.beginAutomationSession();
    } catch (error) {
      this.host.events.releaseCommand(idempotencyKey, requestHash);
      throw error;
    }
    const now = this.timestamp();
    this.state = {
      ...this.initialState(),
      status: "running",
      phase: "baseline",
      requestedMaxCycles: maxCycles,
      sessionId,
      startedAt: now,
      updatedAt: now,
      // 最近一次完成的评测在新一轮基线评测刷新前仍然有效。
      lastEvaluation: this.state.lastEvaluation,
    };
    this.session = session;
    this.abortController = new AbortController();
    const loopSignal = this.abortController.signal;
    const loop = this.runLoop(
      session,
      sessionId,
      commandId,
      operator,
      maxCycles,
      loopSignal,
    )
      .catch((error: unknown) => {
        if (loopSignal.aborted && error === loopSignal.reason) {
          this.finish("stopped", this.state.stopReason ?? "Automatic evolution was stopped");
          return;
        }
        const infrastructure = infrastructureFailureFrom(error);
        this.state.error = error instanceof Error ? error.message : String(error);
        if (infrastructure) {
          this.state.failureCode = infrastructure.code;
          this.finish(
            "paused",
            `Paused for provider infrastructure failure ${infrastructure.code}: ${infrastructure.summary}`,
          );
          return;
        }
        this.finish("failed", "Automatic evolution failed closed");
      })
      .finally(() => {
        if (this.loop === loop) this.loop = undefined;
        this.abortController = undefined;
        this.session = undefined;
      });
    this.loop = loop;
    void loop.catch(() => undefined);
    return this.snapshot();
  }

  async stop(reason = "Stopped by the local operator"): Promise<AutomaticEvolutionSnapshot> {
    if (!this.loop || !this.abortController) {
      throw new AutomaticEvolutionError(
        "AUTOMATION_NOT_RUNNING",
        "Automatic evolution is not running",
      );
    }
    this.state.status = "stopping";
    this.state.phase = "stopping";
    this.state.stopReason = reason;
    this.touch();
    this.abortController.abort(new Error(reason));
    if (this.state.activeRunId) this.session?.cancel(this.state.activeRunId);
    await this.loop;
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (!this.loop || !this.abortController) return;
    this.state.stopReason = "Control service closed";
    this.abortController.abort(new Error(this.state.stopReason));
    if (this.state.activeRunId) this.session?.cancel(this.state.activeRunId);
    await this.loop;
  }

  private async runLoop(
    session: AutomaticEvolutionRunSession,
    sessionId: string,
    startCommandId: string,
    operator: string,
    maxCycles: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const incumbent = await this.resolveIncumbent();
      this.state.incumbentStrategy = incumbent.strategy;
      this.state.phase = "baseline";
      this.touch();
      let incumbentDefinition = incumbent.definition;
      let incumbentOutcome = await this.evaluateStrategy(
        session,
        incumbent.strategy,
        `baseline-${sessionId}`,
        signal,
      );
      this.state.incumbentScore = incumbentOutcome.score;
      this.touch();

      for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
        signal.throwIfAborted();
        this.state.phase = "proposing";
        this.touch();
        const proposed = await this.generateCandidate({
          project: this.loaded.config.project.name,
          cycle,
          maxCycles,
          targetStrategy: this.config.targetStrategy,
          incumbentStrategy: this.state.incumbentStrategy!,
          incumbentScore: incumbentOutcome.score,
          incumbentDefinition,
          previousCycles: this.state.cycles.map((entry) => ({
            cycle: entry.cycle,
            scoreDelta: entry.scoreDelta,
            decision: entry.decision,
          })),
          constraints: {
            evaluationRepeats: this.config.evaluationRepeats,
            minimumScoreDelta: this.config.minimumScoreDelta,
            maxConsecutiveNoImprovement: this.config.maxConsecutiveNoImprovement,
            budgetsMustNotExceedIncumbent: true,
          },
        }, signal);
        signal.throwIfAborted();
        const checkedCandidate = this.strategies.preflight(
          this.config.targetStrategy,
          proposed.definition,
        );
        const incumbentResolved = resolveStrategy(
          this.loaded.config,
          this.state.incumbentStrategy!,
        );
        assertBudgetsDoNotExpand(incumbentResolved, checkedCandidate.resolved);

        const proposalId = automaticProposalId(startCommandId, cycle);
        const candidate: EvolutionCandidate = {
          kind: "strategy-blueprint",
          name: this.config.targetStrategy,
          definition: proposed.definition,
        };
        await this.coordinator.propose({
          id: proposalId,
          candidate,
          policy: automaticPolicy(),
          origin: "automatic-controller-v1",
        });
        signal.throwIfAborted();

        this.state.phase = "evaluating";
        this.touch();
        const shadowName = shadowStrategyName(proposalId);
        await this.withTargetMutation(session, async () => {
          await this.strategies.saveAutomaticShadow(shadowName, proposed.definition);
        });
        let candidateOutcome: AutomaticOutcomeAggregate;
        try {
          candidateOutcome = await this.evaluateStrategy(
            session,
            shadowName,
            `candidate-${sessionId}-${cycle}`,
            signal,
          );
        } finally {
          await this.withTargetMutation(session, async () => {
            if (this.strategies.customDefinition(shadowName)) {
              await this.strategies.deleteAutomaticShadow(shadowName);
            }
          });
        }

        signal.throwIfAborted();
        this.state.phase = "deciding";
        this.touch();
        await this.coordinator.beginEvaluation(proposalId);
        const suite = requireEvaluationSuite(
          await resolveEvaluationSuite(this.loaded.config, this.loaded.root),
          "Automatic evolution evaluation evidence",
        );
        const evaluated = await this.coordinator.evaluateAutomaticRun(proposalId, {
          proposalId,
          candidateDigest: computeCandidateDigest(candidate),
          items: automaticRunEvidenceItems(
            incumbentOutcome,
            candidateOutcome,
            this.config.minimumScoreDelta,
            {
              suiteName: suite.name,
              suiteDigest: computeSuiteDigest(suite),
            },
          ),
        });
        signal.throwIfAborted();
        const improved = automaticCandidateImproved(
          incumbentOutcome,
          candidateOutcome,
          this.config.minimumScoreDelta,
        );
        const incumbentScoreBefore = incumbentOutcome.score;
        if (improved) {
          this.state.phase = "applying";
          this.touch();
          const preview = await this.coordinator.previewPromotion({
            proposalId,
            operator,
            expectedRevision: evaluated.committedRevision,
          });
          signal.throwIfAborted();
          await this.withTargetMutation(session, async () => {
            await this.coordinator.promoteAndApply({
              commandId: automaticApplicationCommandId(startCommandId, cycle),
              proposalId,
              expectedRevision: evaluated.committedRevision,
              token: preview.token,
              operator,
              reason: `Authorized automatic command '${startCommandId}' improved deterministic score by ${candidateOutcome.score - incumbentOutcome.score}`,
            });
            this.strategies.setRuntimeDefault(this.config.targetStrategy);
          });
          incumbentDefinition = proposed.definition;
          incumbentOutcome = candidateOutcome;
          this.state.incumbentStrategy = this.config.targetStrategy;
          this.state.incumbentScore = incumbentOutcome.score;
          this.state.consecutiveNoImprovement = 0;
        } else {
          await this.coordinator.reject(proposalId, {
            operator,
            reason: `Authorized automatic command '${startCommandId}' produced score ${candidateOutcome.score}, which did not exceed incumbent ${incumbentOutcome.score} by required delta ${this.config.minimumScoreDelta}`,
          });
          this.state.consecutiveNoImprovement += 1;
        }
        const cycleRecord: AutomaticEvolutionCycle = {
          cycle,
          proposalId,
          rationale: proposed.rationale,
          candidateDefinition: structuredClone(proposed.definition),
          candidateRunIds: [...candidateOutcome.runIds],
          incumbentScore: incumbentScoreBefore,
          candidateScore: candidateOutcome.score,
          scoreDelta: candidateOutcome.score - incumbentScoreBefore,
          improved,
          decision: improved ? "promoted" : "rejected",
          completedAt: this.timestamp(),
        };
        this.state.cycles.push(cycleRecord);
        this.state.completedCycles = cycle;
        this.touch();

        if (this.state.consecutiveNoImprovement >= this.config.maxConsecutiveNoImprovement) {
          this.finish(
            "completed",
            `Stopped after ${this.state.consecutiveNoImprovement} consecutive cycles without improvement`,
          );
          return;
        }
      }
      this.finish("completed", `Reached the bounded limit of ${maxCycles} cycle(s)`);
    } finally {
      session.release();
    }
  }

  private async resolveIncumbent(): Promise<{ strategy: string; definition: NamedStrategy }> {
    const control = await this.coordinator.readControlSnapshot();
    const active = control.catalog.activeProposals.find(
      (entry) =>
        entry.target.kind === "strategy-blueprint" &&
        entry.target.name === this.config.targetStrategy,
    );
    const activeProposal = active
      ? control.catalog.proposals.find((proposal) => proposal.id === active.proposalId)
      : undefined;
    const application = activeProposal
      ? control.application.applications.find((entry) => entry.proposalId === activeProposal.id)
      : undefined;
    const evolved = this.strategies.customDefinition(this.config.targetStrategy);
    if (
      evolved &&
      activeProposal?.evaluation?.source === "server-automatic-run-evaluation-v1" &&
      activeProposal.candidate.kind === "strategy-blueprint" &&
      application?.afterTargetDigest &&
      isDeepStrictEqual(evolved, activeProposal.candidate.definition)
    ) {
      this.strategies.setRuntimeDefault(this.config.targetStrategy);
      return { strategy: this.config.targetStrategy, definition: evolved };
    }
    if (evolved) {
      throw new AutomaticEvolutionError(
        "AUTOMATION_TARGET_CONFLICT",
        `Automatic evolution target '${this.config.targetStrategy}' already exists without matching active application proof`,
      );
    }
    const baseline = this.config.baselineStrategy ?? this.loaded.config.strategies!.default;
    const definition = this.loaded.config.strategies!.definitions[baseline];
    if (!definition) throw new Error(`Automatic evolution baseline '${baseline}' is missing`);
    return { strategy: baseline, definition: structuredClone(definition) };
  }

  private async cleanupAutomaticShadows(proposals: readonly EvolutionProposal[]): Promise<void> {
    const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const names = this.strategies.automaticShadowNames().filter((name) => {
      const proposalId = automaticProposalIdForShadow(name);
      const proposal = proposalById.get(proposalId);
      const definition = this.strategies.customDefinition(name);
      return Boolean(
        proposal?.origin === "automatic-controller-v1" &&
        proposal.candidate.kind === "strategy-blueprint" &&
        definition &&
        isDeepStrictEqual(definition, proposal.candidate.definition),
      );
    });
    if (names.length === 0) return;
    const release = this.host.beginEvolutionMutation();
    try {
      for (const name of names) await this.strategies.deleteAutomaticShadow(name);
    } finally {
      release();
    }
  }

  private async evaluateStrategy(
    session: AutomaticEvolutionRunSession,
    strategy: string,
    intentKey: string,
    signal: AbortSignal,
  ): Promise<AutomaticOutcomeAggregate> {
    const suite = requireEvaluationSuite(
      await resolveEvaluationSuite(this.loaded.config, this.loaded.root),
      "Automatic evolution evaluation",
    );
    const suiteDigest = computeSuiteDigest(suite);
    const pairings: Array<{ taskId: string; state: RunState }> = [];
    const allBindings = await this.resolveGlobalRoleBindings();
    // Strategy roleProfiles 是被评测变量，必须赢过全局 CLI 默认；全局默认只补未映射的角色。
    const strategyRoleProfiles = resolveStrategy(this.loaded.config, strategy).roleProfiles;
    const roleBindings = allBindings
      ? Object.fromEntries(
          Object.entries(allBindings).filter(([role]) => !(role in strategyRoleProfiles)),
        )
      : undefined;
    const effectiveBindings =
      roleBindings && Object.keys(roleBindings).length > 0 ? roleBindings : undefined;
    this.state.roleBindingSource = effectiveBindings ? "global-cli-defaults" : "project-yaml";
    this.touch();

    for (const task of suite.tasks) {
      for (let repeat = 1; repeat <= suite.repeats; repeat += 1) {
        signal.throwIfAborted();
        const result = session.start(
          {
            goal: task.goal,
            strategy,
            profileOverrides: {},
            ...(effectiveBindings ? { roleBindings: effectiveBindings } : {}),
          },
          `automatic-evolution:${intentKey}:${task.id}:${repeat}`,
        );
        this.state.activeRunId = result.runId;
        this.touch();
        const state =
          (await this.host.wait(result.runId)) ??
          (await this.host.get(result.runId));
        this.state.activeRunId = null;
        this.touch();
        if (!state) {
          throw new Error(`Automatic evaluation run '${result.runId}' did not persist state`);
        }
        if (
          state.id !== result.runId ||
          state.goal !== task.goal ||
          state.strategy.name !== strategy ||
          state.purpose !== "evolution-evaluation"
        ) {
          throw new Error(
            `Automatic evaluation run '${result.runId}' does not match its server-owned evaluation request`,
          );
        }
        const infrastructure = infrastructureFailureFromRun(state);
        if (infrastructure) {
          throw new ProviderFailureError(
            `Automatic evaluation run '${result.runId}' hit provider infrastructure failure ${infrastructure.code}`,
            infrastructure,
          );
        }
        pairings.push({ taskId: task.id, state });
      }
    }

    const suiteAggregate = scoreEvaluationSuite(suite, pairings);
    // Preserve AutomaticOutcomeAggregate contract while ranking by suite worst-score.
    const outcomes = suiteAggregate.scores.map((score) => {
      const state = pairings.find(
        (entry) => entry.taskId === score.taskId && entry.state.id === score.runId,
      )?.state;
      const projected = state ? projectRunOutcome(state) : undefined;
      return {
        runId: score.runId,
        passed: score.passed,
        score: score.score,
        status: score.status,
        qualityPassed: projected?.qualityPassed ?? score.passed,
        finalDecision: projected?.finalDecision ?? null,
        commandsPassed: projected?.commandsPassed ?? 0,
        commandsTotal: projected?.commandsTotal ?? 0,
        tasksMerged: score.tasksMerged,
        tasksTotal: score.tasksTotal,
        totalAttempts: score.totalAttempts,
        agentInvocations: score.agentInvocations,
      };
    });

    // Record suite identity so operators can bind experience promotions to the
    // exact evaluation evidence that produced this aggregate.
    this.state.lastEvaluation = {
      suiteName: suite.name,
      suiteDigest,
      completedAt: this.timestamp(),
    };
    this.touch();
    try {
      await this.stateStore.saveLastEvaluation(this.state.lastEvaluation);
    } catch (error) {
      // 提示性数据的落盘失败不应中止评测循环。
      console.warn(
        `[evolution-automation] failed to persist last evaluation record: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      runIds: outcomes.map((outcome) => outcome.runId),
      passed: suiteAggregate.passed,
      score: suiteAggregate.score,
      outcomes,
    };
  }

  /**
   * 本机全局 CLI 默认（~/.agent-team/desktop-settings.json）→ roleBindings。
   * 仅当 evolution.automatic.useGlobalCliDefaults = true 时启用。
   * 返回值约定：undefined 未解析过 / null 不可用（退回项目 yaml 默认）。
   */
  private async resolveGlobalRoleBindings(): Promise<Record<string, RoleBinding> | undefined> {
    if (!this.config.useGlobalCliDefaults) return undefined;
    if (this.globalRoleBindings !== undefined) {
      return this.globalRoleBindings ?? undefined;
    }
    try {
      const settings = await loadDesktopSettings(this.desktopHome);
      const { inventory } = await getInventory({
        refresh: false,
        ...(this.desktopHome ? { home: this.desktopHome } : {}),
      });
      const merged = mergeRoleDefaults(settings, inventory);
      // 只保留本项目存在的角色
      const filtered = Object.fromEntries(
        Object.entries(merged).filter(([role]) => role in this.loaded.config.roles),
      );
      this.globalRoleBindings = Object.keys(filtered).length > 0 ? filtered : null;
    } catch {
      this.globalRoleBindings = null;
    }
    return this.globalRoleBindings ?? undefined;
  }

  private async generateCandidate(
    context: AutomaticProposalContext,
    signal: AbortSignal,
  ): Promise<AutomaticStrategyCandidate> {
    if (this.proposeCandidate) return await this.proposeCandidate(context, signal);
    const runId = createRunId(`automatic evolution proposer cycle ${context.cycle}`);
    const baseCommit = await new GitManager(
      this.loaded.root,
      path.resolve(this.loaded.root, this.loaded.config.project.stateDirectory, "worktrees"),
    ).resolveCommit(this.loaded.config.project.defaultBranch);
    const now = this.timestamp();
    const state: RunState = {
      id: runId,
      goal: `Generate automatic strategy candidate for cycle ${context.cycle}`,
      root: this.loaded.root,
      configPath: this.loaded.path,
      baseBranch: this.loaded.config.project.defaultBranch,
      baseCommit,
      integrationBranch: this.loaded.config.project.defaultBranch,
      integrationWorktree: this.loaded.root,
      status: "orchestrating",
      createdAt: now,
      updatedAt: now,
      profileOverrides: {},
      strategy: proposerBudgetStrategy(
        resolveStrategy(this.loaded.config, context.incumbentStrategy),
        this.loaded.config.roles[this.config.proposerRole]?.fallbackProfiles.length ?? 0,
      ),
      supervisorId: this.host.id,
      purpose: "evolution-proposer",
      tasks: [],
      history: [{
        at: now,
        status: "orchestrating",
        message: `Generating bounded automatic strategy candidate for cycle ${context.cycle}`,
      }],
    };
    await this.artifactStore.save(state);
    const deadline = createExecutionDeadline(state.strategy.executionTimeoutSeconds, signal);
    const budget = new RunBudgetTracker(state, this.artifactStore);
    const agent = new ProfiledAgentService(
      this.loaded.config,
      this.loaded.root,
      this.artifactStore,
      {},
      deadline.signal,
      budget,
    );
    try {
      const response = await agent.runStructured({
        role: this.config.proposerRole,
        ...(this.config.proposerProfile ? { profileName: this.config.proposerProfile } : {}),
        promptKey: "evolution-proposer",
        runId,
        artifactKey: "proposal",
        context,
        schema: automaticStrategyCandidateSchema,
        jsonSchema: z.toJSONSchema(automaticStrategyCandidateSchema) as Record<string, unknown>,
      });
      await this.artifactStore.transition(
        state,
        "completed",
        `Generated automatic strategy candidate for cycle ${context.cycle}`,
      );
      return response.value;
    } catch (error) {
      state.error = boundedErrorMessage(error);
      await this.artifactStore.transition(
        state,
        signal.aborted ? "cancelled" : "blocked",
        state.error,
      );
      throw error;
    } finally {
      deadline.dispose();
    }
  }

  private async withTargetMutation<T>(
    session: AutomaticEvolutionRunSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = session.beginTargetMutation();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private initialState(): AutomaticEvolutionSnapshot {
    const baseline = this.config.baselineStrategy ?? this.loaded.config.strategies?.default ?? null;
    return {
      enabled: this.config.enabled,
      autoStart: this.config.autoStart,
      status: "idle",
      phase: "idle",
      configuredMaxCycles: this.config.maxCycles,
      requestedMaxCycles: null,
      completedCycles: 0,
      maxConsecutiveNoImprovement: this.config.maxConsecutiveNoImprovement,
      consecutiveNoImprovement: 0,
      evaluationRepeats: this.config.evaluationRepeats,
      minimumScoreDelta: this.config.minimumScoreDelta,
      baselineStrategy: baseline,
      targetStrategy: this.config.targetStrategy,
      sessionId: null,
      activeRunId: null,
      incumbentScore: null,
      incumbentStrategy: null,
      stopReason: null,
      error: null,
      failureCode: null,
      roleBindingSource: null,
      startedAt: null,
      updatedAt: this.timestamp(),
      lastEvaluation: null,
      cycles: [],
    };
  }

  private finish(
    status: "completed" | "stopped" | "paused" | "failed",
    reason: string,
  ): void {
    this.state.status = status;
    this.state.phase = "finished";
    this.state.stopReason = reason;
    this.state.activeRunId = null;
    this.touch();
  }

  private touch(): void {
    this.state.updatedAt = this.timestamp();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function automaticPolicy(): EvolutionPolicy {
  return {
    version: EVOLUTION_DOMAIN_VERSION,
    capabilities: {
      automaticExecution: false,
      automaticPromotion: false,
      networkPublication: false,
      secretStorage: false,
    },
    allowedPromptPaths: [],
  };
}

function shadowStrategyName(proposalId: string): string {
  const match = /^auto-([a-f0-9]{24})-([1-9][0-9]?)$/.exec(proposalId);
  if (!match) throw new Error(`Automatic proposal '${proposalId}' cannot derive a shadow strategy`);
  return `auto-eval-${match[1]}-${match[2]}`;
}

function automaticProposalIdForShadow(shadowName: string): string {
  const match = /^auto-eval-([a-f0-9]{24})-([1-9][0-9]?)$/.exec(shadowName);
  if (!match) throw new Error(`Automatic shadow '${shadowName}' has an invalid reserved name`);
  return `auto-${match[1]}-${match[2]}`;
}

function automaticStartRequestHash(maxCycles: number, operator: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ maxCycles, operator }))
    .digest("hex");
}

function automaticStartResponse(
  value: unknown,
  commandId: string,
): { sessionId: string; maxCycles: number; operator: string } {
  const parsed = z.object({
    sessionId: z.string().min(1),
    maxCycles: z.number().int().min(1),
    operator: z.string().min(1),
  }).strict().safeParse(value);
  if (!parsed.success) {
    throw new AutomaticEvolutionError(
      "AUTOMATION_COMMAND_CONFLICT",
      `Automatic evolution command '${commandId}' has an invalid persisted response`,
    );
  }
  return parsed.data;
}

function automaticProposalId(commandId: string, cycle: number): string {
  return `auto-${automaticCommandDigest(commandId)}-${cycle}`;
}

function automaticApplicationCommandId(commandId: string, cycle: number): string {
  return `auto-apply:${automaticCommandDigest(commandId)}:${cycle}`;
}

function automaticCommandDigest(commandId: string): string {
  return createHash("sha256").update(commandId).digest("hex").slice(0, 24);
}

function assertBudgetsDoNotExpand(
  incumbent: ResolvedStrategy,
  candidate: ResolvedStrategy,
): void {
  const budgets: Array<keyof ResolvedStrategy> = [
    "maxParallel",
    "maxReworkAttempts",
    "maxAgentInvocations",
    "executionTimeoutSeconds",
    "maxProcessOutputBytes",
    "maxArtifactBytes",
    "approvalTimeoutSeconds",
  ];
  for (const budget of budgets) {
    const incumbentValue = incumbent[budget];
    const candidateValue = candidate[budget];
    if (
      typeof incumbentValue === "number" &&
      typeof candidateValue === "number" &&
      candidateValue > incumbentValue
    ) {
      throw new AutomaticEvolutionError(
        "AUTOMATION_BUDGET_EXPANSION",
        `Automatic candidate cannot increase ${budget} above incumbent value ${incumbentValue}`,
      );
    }
  }
}

function proposerBudgetStrategy(
  incumbent: ResolvedStrategy,
  fallbackCount: number,
): ResolvedStrategy {
  return {
    ...incumbent,
    name: `${incumbent.name}:evolution-proposer`,
    maxAgentInvocations: Math.min(incumbent.maxAgentInvocations, 1 + fallbackCount),
    executionTimeoutSeconds: Math.min(incumbent.executionTimeoutSeconds, 1_800),
    maxProcessOutputBytes: Math.min(incumbent.maxProcessOutputBytes, 1_048_576),
    maxArtifactBytes: Math.min(incumbent.maxArtifactBytes, 16_777_216),
  };
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)} [truncated]`;
}

function infrastructureFailureFrom(
  error: unknown,
): ProviderFailureClassification | undefined {
  if (error instanceof ProviderFailureError) {
    return error.classification.pauseEvolution || error.classification.infrastructure
      ? error.classification
      : undefined;
  }
  if (error instanceof RoleProfileChainError) {
    return error.attempts.find((attempt) => attempt.classification.pauseEvolution)
      ?.classification;
  }
  const classification = classifyError(error);
  return classification.pauseEvolution ? classification : undefined;
}

function infrastructureFailureFromRun(
  state: RunState,
): ProviderFailureClassification | undefined {
  if (state.status !== "blocked" && state.status !== "interrupted") return undefined;
  const message = state.error ?? state.history.at(-1)?.message;
  if (!message) return undefined;
  const classification = classifyProviderFailureMessage(message);
  return classification.pauseEvolution ? classification : undefined;
}

function classifyProviderFailureMessage(message: string): ProviderFailureClassification {
  return classifyError(new Error(message));
}
