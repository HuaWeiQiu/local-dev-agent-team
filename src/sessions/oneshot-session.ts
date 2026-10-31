import { AgentInvocationError, invokeAgent } from "../adapters/invoke.js";
import type { AgentRunResult } from "../adapters/types.js";
import type { InvokeOptions } from "../adapters/invoke.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { SessionEventHub } from "./hub.js";
import {
  NO_CAPABILITIES,
  SessionError,
  type AgentSession,
  type OpenSessionOptions,
  type SessionCapabilities,
  type SessionEventListener,
  type TurnInput,
  type TurnResult,
} from "./types.js";

/**
 * Adapts a request/response adapter (Grok, Kimi, or Codex/Claude when a live
 * session is unavailable) to the session interface. Every capability flag is
 * false: there is nothing to steer or interrupt except by cancelling.
 */
interface Turn {
  turnId: string;
  startedAt: number;
}

/** A timeout reads differently from a plain non-zero exit. */
function failureMessage(error: unknown, message: string): string {
  const timedOut = error instanceof AgentInvocationError && error.result.process.timedOut;
  return timedOut ? `timed out: ${message}` : message;
}

export class OneShotSession implements AgentSession {
  readonly kind = "one-shot" as const;
  readonly capabilities: SessionCapabilities = NO_CAPABILITIES;
  readonly nativeSessionId = undefined;
  private readonly hub = new SessionEventHub();
  private turnCounter = 0;
  private closed = false;
  private running = false;

  constructor(
    private readonly options: OpenSessionOptions,
    private readonly registry: AdapterRegistry,
    private readonly extra: { artifactDirectory?: string; runId?: string } = {},
  ) {}

  onEvent(listener: SessionEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    this.assertReady();
    const turn = this.beginTurn();
    try {
      const result = await invokeAgent(this.invocationFor(turn.turnId, input), this.registry);
      return this.completeTurn(turn, result);
    } catch (error) {
      return this.failTurn(turn, error, input.signal);
    } finally {
      this.running = false;
    }
  }

  private assertReady(): void {
    if (this.closed) throw new SessionError("session is closed", "closed");
    if (this.running) throw new SessionError("a turn is already running", "protocol");
  }

  private beginTurn(): { turnId: string; startedAt: number } {
    const turnId = `turn-${++this.turnCounter}`;
    const startedAt = Date.now();
    this.running = true;
    this.hub.emit({ type: "turn-started", turnId });
    return { turnId, startedAt };
  }

  private invocationFor(turnId: string, input: TurnInput): InvokeOptions {
    return {
      adapterName: this.options.adapterName,
      profile: this.options.profile,
      cwd: this.options.cwd,
      prompt: input.prompt,
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(this.extra.artifactDirectory ? { artifactDirectory: this.extra.artifactDirectory } : {}),
      ...(this.extra.runId ? { runId: this.extra.runId } : {}),
      onStdout: (chunk) => this.hub.emit({ type: "text-delta", turnId, text: chunk }),
    };
  }

  private completeTurn(turn: Turn, result: AgentRunResult): TurnResult {
    this.hub.emit({ type: "message", turnId: turn.turnId, text: result.text, final: true });
    if (result.usage) this.hub.emit({ type: "usage", turnId: turn.turnId, usage: result.usage });
    this.hub.emit({ type: "turn-completed", turnId: turn.turnId, status: "completed" });
    return {
      turnId: turn.turnId,
      status: "completed",
      text: result.text,
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      durationMs: Date.now() - turn.startedAt,
    };
  }

  private failTurn(turn: Turn, error: unknown, signal: AbortSignal | undefined): TurnResult {
    if (signal?.aborted) {
      this.hub.emit({ type: "turn-completed", turnId: turn.turnId, status: "interrupted" });
      return { turnId: turn.turnId, status: "interrupted", text: "", durationMs: Date.now() - turn.startedAt };
    }
    const message = error instanceof Error ? error.message : String(error);
    this.hub.emit({ type: "turn-completed", turnId: turn.turnId, status: "failed" });
    return {
      turnId: turn.turnId,
      status: "failed",
      text: error instanceof AgentInvocationError ? error.result.text : "",
      durationMs: Date.now() - turn.startedAt,
      error: failureMessage(error, message),
    };
  }

  async steer(): Promise<void> {
    throw new SessionError("this agent cannot be steered mid-turn", "unsupported");
  }

  async interrupt(): Promise<void> {
    throw new SessionError("this agent cannot be interrupted without cancelling the run", "unsupported");
  }

  async answer(): Promise<void> {
    throw new SessionError("this agent cannot ask questions", "unsupported");
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
