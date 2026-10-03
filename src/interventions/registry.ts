import { randomUUID } from "node:crypto";
import {
  SessionError,
  type AgentSession,
  type SessionCapabilities,
  type SessionEvent,
  type SessionKind,
} from "../sessions/types.js";

export type LedgerEmit = (runId: string, type: string, payload: unknown) => void;

export interface PendingQuestionView {
  questionId: string;
  prompt: string;
  options?: string[];
  secret: boolean;
  askedAt: string;
}

export interface LiveAgentView {
  /** Opaque, stable for the lifetime of one invocation. */
  id: string;
  runId: string;
  role: string;
  artifactKey: string;
  taskId?: string;
  profile: string;
  adapter: string;
  model: string;
  kind: SessionKind;
  capabilities: SessionCapabilities;
  startedAt: string;
  lastActivityAt: string;
  status: "running" | "awaiting-answer";
  questions: PendingQuestionView[];
}

export interface AttachInput {
  runId: string;
  role: string;
  artifactKey: string;
  taskId?: string;
  profile: string;
  adapter: string;
  model: string;
}

export interface InterruptDirective {
  actor: string;
  /** With a note the agent continues the same conversation with it; without, the attempt ends. */
  note?: string;
}

export interface LiveAgentHandle {
  readonly id: string;
  /** Returns and clears an operator interrupt requested for the current turn. */
  takeInterrupt(): InterruptDirective | undefined;
  detach(): void;
}

/** Raised when an operator stops an agent without redirecting it. */
export class OperatorInterruptError extends Error {
  override readonly name = "OperatorInterruptError";
  readonly code = "OPERATOR_INTERRUPT";

  constructor(readonly actor: string, readonly role: string) {
    super(`Operator ${actor} interrupted the ${role} agent before it finished`);
  }
}

export class InterventionError extends Error {
  override readonly name = "InterventionError";

  constructor(
    message: string,
    readonly code: "not-found" | "unsupported" | "invalid",
  ) {
    super(message);
  }
}

interface Entry {
  view: LiveAgentView;
  session: AgentSession;
  interrupt?: InterruptDirective;
  unsubscribe: () => void;
}

/**
 * Tracks every running agent session so operators can steer, interrupt or
 * answer them. In-memory by design: sessions die with their process, and every
 * intervention is written to the run ledger for audit and replay.
 */
export class LiveAgentRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly emit: LedgerEmit) {}

  attach(input: AttachInput, session: AgentSession): LiveAgentHandle {
    const now = new Date().toISOString();
    const id = randomUUID();
    const view: LiveAgentView = {
      id,
      runId: input.runId,
      role: input.role,
      artifactKey: input.artifactKey,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      profile: input.profile,
      adapter: input.adapter,
      model: input.model,
      kind: session.kind,
      capabilities: session.capabilities,
      startedAt: now,
      lastActivityAt: now,
      status: "running",
      questions: [],
    };
    const entry: Entry = {
      view,
      session,
      unsubscribe: session.onEvent((event) => this.observe(entry, event)),
    };
    this.entries.set(id, entry);
    this.emit(input.runId, "agent.session.opened", {
      agentId: id,
      role: input.role,
      artifactKey: input.artifactKey,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      profile: input.profile,
      adapter: input.adapter,
      kind: session.kind,
      capabilities: session.capabilities,
    });
    return {
      id,
      takeInterrupt: () => {
        const directive = entry.interrupt;
        delete entry.interrupt;
        return directive;
      },
      detach: () => {
        if (!this.entries.delete(id)) return;
        entry.unsubscribe();
        this.emit(input.runId, "agent.session.closed", { agentId: id, role: input.role });
      },
    };
  }

  list(runId?: string): LiveAgentView[] {
    return [...this.entries.values()]
      .map((entry) => structuredClone(entry.view))
      .filter((view) => runId === undefined || view.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async steer(runId: string, agentId: string, text: string, actor: string): Promise<void> {
    const entry = this.require(runId, agentId);
    if (!entry.view.capabilities.steer) {
      throw new InterventionError(
        `${entry.view.adapter} sessions cannot be steered mid-turn; interrupt and restart with guidance instead`,
        "unsupported",
      );
    }
    await this.translate(() => entry.session.steer(text));
    this.touch(entry);
    this.emit(runId, "agent.steered", {
      agentId,
      role: entry.view.role,
      ...(entry.view.taskId ? { taskId: entry.view.taskId } : {}),
      actor,
      text,
    });
  }

  async interrupt(runId: string, agentId: string, directive: InterruptDirective): Promise<void> {
    const entry = this.require(runId, agentId);
    if (!entry.view.capabilities.interrupt) {
      throw new InterventionError(
        `${entry.view.adapter} sessions cannot be interrupted; cancel the run instead`,
        "unsupported",
      );
    }
    entry.interrupt = directive;
    try {
      await this.translate(() => entry.session.interrupt());
    } catch (error) {
      delete entry.interrupt;
      throw error;
    }
    this.touch(entry);
    this.emit(runId, "agent.interrupted", {
      agentId,
      role: entry.view.role,
      ...(entry.view.taskId ? { taskId: entry.view.taskId } : {}),
      actor: directive.actor,
      redirected: directive.note !== undefined,
      ...(directive.note !== undefined ? { note: directive.note } : {}),
    });
  }

  async answer(
    runId: string,
    agentId: string,
    questionId: string,
    answer: string,
    actor: string,
  ): Promise<void> {
    const entry = this.require(runId, agentId);
    const question = entry.view.questions.find((item) => item.questionId === questionId);
    if (!question) {
      throw new InterventionError(`Question '${questionId}' is not pending`, "not-found");
    }
    await this.translate(() => entry.session.answer(questionId, answer));
    entry.view.questions = entry.view.questions.filter((item) => item.questionId !== questionId);
    entry.view.status = entry.view.questions.length > 0 ? "awaiting-answer" : "running";
    this.touch(entry);
    // A secret answer is delivered to the agent but never written to the ledger.
    this.emit(runId, "agent.answered", {
      agentId,
      role: entry.view.role,
      questionId,
      actor,
      ...(question.secret ? { redacted: true } : { answer }),
    });
  }

  private observe(entry: Entry, event: SessionEvent): void {
    this.touch(entry);
    const { view } = entry;
    if (event.type === "question") {
      const question: PendingQuestionView = {
        questionId: event.questionId,
        prompt: event.prompt,
        ...(event.options ? { options: event.options } : {}),
        secret: event.secret === true,
        askedAt: new Date().toISOString(),
      };
      view.questions = [...view.questions.filter((item) => item.questionId !== question.questionId), question];
      view.status = "awaiting-answer";
      this.emit(view.runId, "agent.question", {
        agentId: view.id,
        role: view.role,
        ...(view.taskId ? { taskId: view.taskId } : {}),
        questionId: question.questionId,
        prompt: question.prompt,
        ...(question.options ? { options: question.options } : {}),
        secret: question.secret,
      });
      return;
    }
    if (event.type === "turn-completed") {
      view.questions = [];
      view.status = "running";
    }
  }

  private touch(entry: Entry): void {
    entry.view.lastActivityAt = new Date().toISOString();
  }

  private require(runId: string, agentId: string): Entry {
    const entry = this.entries.get(agentId);
    if (!entry || entry.view.runId !== runId) {
      throw new InterventionError(`Agent '${agentId}' is not running in run '${runId}'`, "not-found");
    }
    return entry;
  }

  private async translate(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof SessionError) {
        throw new InterventionError(
          error.message,
          error.code === "unsupported" ? "unsupported" : "invalid",
        );
      }
      throw error;
    }
  }
}
