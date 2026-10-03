import { AgentInvocationError, invokeAgent } from "../adapters/invoke.js";
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
    if (this.closed) throw new SessionError("session is closed", "closed");
    if (this.running) throw new SessionError("a turn is already running", "protocol");
    input.signal?.throwIfAborted();
    const turnId = `turn-${++this.turnCounter}`;
    const startedAt = Date.now();
    this.running = true;
    this.hub.emit({ type: "turn-started", turnId });
    try {
      const result = await invokeAgent(
        {
          adapterName: this.options.adapterName,
          profile: this.options.profile,
          cwd: this.options.cwd,
          prompt: input.prompt,
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(this.extra.artifactDirectory ? { artifactDirectory: this.extra.artifactDirectory } : {}),
          ...(this.extra.runId ? { runId: this.extra.runId } : {}),
          onStdout: (chunk) => this.hub.emit({ type: "text-delta", turnId, text: chunk }),
        },
        this.registry,
      );
      this.hub.emit({ type: "message", turnId, text: result.text, final: true });
      if (result.usage) this.hub.emit({ type: "usage", turnId, usage: result.usage });
      this.hub.emit({ type: "turn-completed", turnId, status: "completed" });
      return {
        turnId,
        status: "completed",
        text: result.text,
        ...(result.structured !== undefined ? { structured: result.structured } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (input.signal?.aborted) {
        this.hub.emit({ type: "turn-completed", turnId, status: "interrupted" });
        return { turnId, status: "interrupted", text: "", durationMs: Date.now() - startedAt };
      }
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof AgentInvocationError && error.result.process.timedOut;
      this.hub.emit({ type: "turn-completed", turnId, status: "failed" });
      return {
        turnId,
        status: "failed",
        text: error instanceof AgentInvocationError ? error.result.text : "",
        durationMs: Date.now() - startedAt,
        error: timedOut ? `timed out: ${message}` : message,
      };
    } finally {
      this.running = false;
    }
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
