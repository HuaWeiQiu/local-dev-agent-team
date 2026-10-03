import type { AgentProfile } from "../config/schema.js";
import type { AgentUsage } from "../adapters/types.js";
import type { LiveChildHandle } from "../process/live-children.js";

/**
 * What a live agent session can do beyond a single request/response. The
 * engine checks these flags instead of assuming every CLI is interactive.
 */
export interface SessionCapabilities {
  /** Inject extra guidance into a turn that is already running. */
  steer: boolean;
  /** Stop the current turn without losing the conversation. */
  interrupt: boolean;
  /** The agent can pause a turn to ask the operator a question. */
  askUser: boolean;
  /** A closed session can be reopened with its previous context. */
  resume: boolean;
}

export const NO_CAPABILITIES: SessionCapabilities = {
  steer: false,
  interrupt: false,
  askUser: false,
  resume: false,
};

export type SessionKind = "codex-app-server" | "claude-stream" | "one-shot";

export type TurnStatus = "completed" | "interrupted" | "failed";

export type SessionEvent =
  | { type: "turn-started"; turnId: string }
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "message"; turnId: string; text: string; final: boolean }
  | {
      type: "tool";
      turnId: string;
      toolId: string;
      name: string;
      status: "started" | "completed" | "failed";
      summary?: string;
    }
  | { type: "usage"; turnId: string; usage: AgentUsage }
  | {
      type: "question";
      turnId: string;
      questionId: string;
      prompt: string;
      options?: string[];
      secret?: boolean;
    }
  | { type: "turn-completed"; turnId: string; status: TurnStatus }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string };

export type SessionEventListener = (event: SessionEvent) => void;

export interface TurnInput {
  prompt: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TurnResult {
  turnId: string;
  status: TurnStatus;
  text: string;
  structured?: unknown;
  usage?: AgentUsage;
  durationMs: number;
  error?: string;
}

export interface AgentSession {
  readonly kind: SessionKind;
  readonly capabilities: SessionCapabilities;
  /** Provider-native conversation id once known; usable to resume later. */
  readonly nativeSessionId: string | undefined;
  onEvent(listener: SessionEventListener): () => void;
  runTurn(input: TurnInput): Promise<TurnResult>;
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
  answer(questionId: string, answer: string): Promise<void>;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  adapterName: string;
  profile: AgentProfile;
  cwd: string;
  /** Previous native session id to continue, when the session kind supports it. */
  resumeSessionId?: string;
  liveChild?: LiveChildHandle;
  env?: NodeJS.ProcessEnv;
}

export class SessionError extends Error {
  override readonly name = "SessionError";
  constructor(
    message: string,
    readonly code: "unsupported" | "not-running" | "protocol" | "process-exit" | "timeout" | "closed",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
