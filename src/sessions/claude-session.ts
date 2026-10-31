import { randomUUID } from "node:crypto";
import { extractUsage, validateProfileArguments } from "../adapters/shared.js";
import type { AgentUsage } from "../adapters/types.js";
import { sanitizedChildEnv } from "../process/env.js";
import { spawnStreamProcess, type StreamProcess } from "../process/stream.js";
import { Deferred, SessionEventHub } from "./hub.js";
import {
  SessionError,
  type AgentSession,
  type OpenSessionOptions,
  type SessionCapabilities,
  type SessionEventListener,
  type TurnInput,
  type TurnResult,
  type TurnStatus,
} from "./types.js";

type Json = Record<string, unknown>;

interface ActiveTurn {
  turnId: string;
  done: Deferred<TurnResult>;
  startedAt: number;
  streamed: string;
  usage: AgentUsage;
  interruptRequested: boolean;
  redirect: string | undefined;
  forced: { status: TurnStatus; error?: string } | undefined;
  structuredSchema: boolean;
}

interface PendingApproval {
  requestId: string;
  toolInput: Json;
  questions: Json[];
  answers: Map<string, string>;
}

const INTERRUPT_GRACE_MS = 5_000;
const QUESTION_TOOL = "AskUserQuestion";

/**
 * Claude Code in `--input-format stream-json` mode. The CLI keeps one
 * conversation alive across turns and accepts control requests (interrupt,
 * permission prompts) on stdin, so the operator can redirect or answer it.
 * It is the same local binary and login the one-shot adapter uses.
 */
export class ClaudeStreamSession implements AgentSession {
  readonly kind = "claude-stream" as const;
  readonly capabilities: SessionCapabilities;
  private readonly hub = new SessionEventHub();
  private readonly approvals = new Map<string, PendingApproval>();
  private proc: StreamProcess | undefined;
  private active: ActiveTurn | undefined;
  private sessionId: string | undefined;
  private turnCounter = 0;
  private controlCounter = 0;
  private closed = false;
  private dead: SessionError | undefined;

  constructor(
    private readonly options: OpenSessionOptions & { sessionSchema?: Record<string, unknown> },
    private readonly command: string,
  ) {
    this.capabilities = {
      steer: true,
      interrupt: true,
      askUser: true,
      resume: options.profile.externalTools === "inherit",
    };
    this.sessionId = options.resumeSessionId;
  }

  get nativeSessionId(): string | undefined {
    return this.sessionId;
  }

  onEvent(listener: SessionEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    if (this.closed) throw new SessionError("session is closed", "closed");
    if (this.dead) throw this.dead;
    if (this.active) throw new SessionError("a turn is already running", "protocol");
    input.signal?.throwIfAborted();
    this.ensureStarted();

    const schemaMatches =
      input.outputSchema === undefined ||
      JSON.stringify(input.outputSchema) === JSON.stringify(this.options.sessionSchema);
    const active: ActiveTurn = {
      turnId: `turn-${++this.turnCounter}`,
      done: new Deferred<TurnResult>(),
      startedAt: Date.now(),
      streamed: "",
      usage: {},
      interruptRequested: false,
      redirect: undefined,
      forced: undefined,
      structuredSchema: input.outputSchema !== undefined,
    };
    this.active = active;

    const onAbort = (): void => {
      void this.forceInterrupt(active, "interrupted");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = input.timeoutMs
      ? setTimeout(() => {
          void this.forceInterrupt(active, "failed", `turn exceeded ${input.timeoutMs}ms`);
        }, input.timeoutMs)
      : undefined;

    this.hub.emit({ type: "turn-started", turnId: active.turnId });
    this.sendUser(schemaMatches ? input.prompt : promptWithSchema(input.prompt, input.outputSchema!));
    try {
      return await active.done.promise;
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (this.active === active) this.active = undefined;
    }
  }

  async steer(text: string): Promise<void> {
    const active = this.active;
    if (!active) throw new SessionError("no turn is running", "not-running");
    // The CLI has no mid-turn injection; redirect by interrupting and
    // continuing the same conversation with the operator's guidance.
    active.redirect = text;
    active.interruptRequested = true;
    this.sendControl({ subtype: "interrupt" });
  }

  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) throw new SessionError("no turn is running", "not-running");
    active.interruptRequested = true;
    this.sendControl({ subtype: "interrupt" });
  }

  async answer(questionId: string, answer: string): Promise<void> {
    const separator = questionId.indexOf("::");
    const requestId = questionId.slice(0, separator);
    const approval = this.approvals.get(requestId);
    if (!approval) throw new SessionError(`unknown question '${questionId}'`, "not-running");
    approval.answers.set(questionId, answer);
    if (approval.questions.every((_, index) => approval.answers.has(`${requestId}::${index}`))) {
      const answers: Record<string, string> = {};
      approval.questions.forEach((question, index) => {
        answers[String(question.question)] = approval.answers.get(`${requestId}::${index}`) ?? "";
      });
      this.approvals.delete(requestId);
      this.sendControlResponse(requestId, {
        behavior: "allow",
        updatedInput: { ...approval.toolInput, answers },
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    this.active?.done.reject(new SessionError("session closed", "closed"));
    if (proc) {
      proc.closeStdin();
      proc.terminate();
      await proc.exited;
    }
  }

  private ensureStarted(): void {
    if (this.proc) return;
    const { profile, cwd } = this.options;
    validateProfileArguments(profile, "claude");
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      profile.permission === "read-only" ? "plan" : "acceptEdits",
      "--permission-prompt-tool",
      "stdio",
      "--effort",
      profile.reasoning,
    ];
    if (!this.capabilities.resume) args.push("--no-session-persistence");
    if (this.options.resumeSessionId) args.push("--resume", this.options.resumeSessionId);
    if (profile.permission === "read-only") {
      args.push("--tools", "Read,Glob,Grep", "--disallowed-tools", "Edit,Write,NotebookEdit,Bash");
    }
    if (profile.model !== "inherit") args.push("--model", profile.model);
    if (profile.externalTools === "deny") {
      args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    }
    if (this.options.sessionSchema) {
      args.push("--json-schema", JSON.stringify(this.options.sessionSchema));
    }
    args.push(...profile.args);

    const proc = spawnStreamProcess({
      command: this.command,
      args,
      cwd,
      env: this.options.env ?? sanitizedChildEnv(),
      onLine: (line) => this.handleLine(line),
      ...(this.options.liveChild ? { liveChild: this.options.liveChild } : {}),
    });
    this.proc = proc;
    void proc.exited.then((exit) => {
      if (this.closed) return;
      const reason = exit.error
        ? `could not start claude: ${exit.error.message}`
        : `claude exited (code ${exit.exitCode ?? "none"}${exit.signal ? `, ${exit.signal}` : ""}): ${proc.stderrTail().slice(-400)}`;
      this.dead = new SessionError(reason, "process-exit");
      this.active?.done.reject(this.dead);
    });
  }

  private sendUser(text: string): void {
    this.proc?.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    );
  }

  private sendControl(request: Json): void {
    this.proc?.write(
      JSON.stringify({ type: "control_request", request_id: `at-${++this.controlCounter}-${randomUUID().slice(0, 8)}`, request }),
    );
  }

  private sendControlResponse(requestId: string, response: Json): void {
    this.proc?.write(
      JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }),
    );
  }

  private async forceInterrupt(active: ActiveTurn, status: TurnStatus, error?: string): Promise<void> {
    active.interruptRequested = true;
    active.redirect = undefined;
    active.forced = { status, ...(error ? { error } : {}) };
    this.sendControl({ subtype: "interrupt" });
    const grace = setTimeout(() => {
      active.done.resolve(this.result(active, status, error));
    }, INTERRUPT_GRACE_MS);
    grace.unref();
    void active.done.promise.finally(() => clearTimeout(grace)).catch(() => undefined);
  }

  private handleLine(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && typeof message.session_id === "string") {
          this.sessionId = message.session_id;
        }
        return;
      case "stream_event":
        this.handleStreamEvent(message.event as Json | undefined);
        return;
      case "assistant":
        this.handleAssistant(message.message as Json | undefined);
        return;
      case "user":
        this.handleToolResults(message.message as Json | undefined);
        return;
      case "control_request":
        this.handleControlRequest(message);
        return;
      case "result":
        this.handleResult(message);
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(event: Json | undefined): void {
    const active = this.active;
    if (!active || event?.type !== "content_block_delta") return;
    const delta = event.delta as Json | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      active.streamed += delta.text;
      this.hub.emit({ type: "text-delta", turnId: active.turnId, text: delta.text });
    }
  }

  private handleAssistant(message: Json | undefined): void {
    const active = this.active;
    if (!active || !Array.isArray(message?.content)) return;
    for (const block of message.content as Json[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        this.hub.emit({ type: "message", turnId: active.turnId, text: block.text, final: false });
      } else if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Json;
        const summary = toolSummary(input);
        this.hub.emit({
          type: "tool",
          turnId: active.turnId,
          toolId: String(block.id),
          name: String(block.name),
          status: "started",
          ...(summary ? { summary } : {}),
        });
      }
    }
  }

  private handleToolResults(message: Json | undefined): void {
    const active = this.active;
    if (!active || !Array.isArray(message?.content)) return;
    for (const block of message.content as Json[]) {
      if (block.type === "tool_result") {
        this.hub.emit({
          type: "tool",
          turnId: active.turnId,
          toolId: String(block.tool_use_id),
          name: "tool_result",
          status: block.is_error === true ? "failed" : "completed",
        });
      }
    }
  }

  private handleControlRequest(message: Json): void {
    const requestId = String(message.request_id);
    const request = (message.request ?? {}) as Json;
    if (request.subtype !== "can_use_tool") {
      this.proc?.write(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "error", request_id: requestId, error: `unsupported control request '${String(request.subtype)}'` },
        }),
      );
      return;
    }
    const toolInput = (request.input ?? {}) as Json;
    if (request.tool_name === QUESTION_TOOL && Array.isArray(toolInput.questions)) {
      const questions = toolInput.questions as Json[];
      this.approvals.set(requestId, { requestId, toolInput, questions, answers: new Map() });
      questions.forEach((question, index) => {
        const options = (question.options as Json[] | undefined)?.map((option) => String(option.label));
        this.hub.emit({
          type: "question",
          turnId: this.active?.turnId ?? "",
          questionId: `${requestId}::${index}`,
          prompt: String(question.question ?? ""),
          ...(options && options.length > 0 ? { options } : {}),
        });
      });
      return;
    }
    // Tools the permission mode would not allow on its own are never granted
    // automatically; the model sees the denial and adapts.
    this.sendControlResponse(requestId, {
      behavior: "deny",
      message: `${String(request.tool_name)} is not permitted for this role`,
    });
    this.hub.emit({
      type: "notice",
      level: "warning",
      message: `denied ${String(request.tool_name)}: not allowed for this role`,
    });
  }

  private handleResult(message: Json): void {
    const active = this.active;
    if (!active) return;
    if (typeof message.session_id === "string") this.sessionId = message.session_id;
    const usage = extractUsage(message);
    if (usage) {
      active.usage = mergeUsage(active.usage, usage);
      this.hub.emit({ type: "usage", turnId: active.turnId, usage: active.usage });
    }

    if (active.interruptRequested && active.redirect !== undefined) {
      const guidance = active.redirect;
      active.redirect = undefined;
      active.interruptRequested = false;
      this.hub.emit({ type: "notice", level: "info", message: "turn redirected by the operator" });
      this.sendUser(`Operator guidance (take this into account and continue the task):\n${guidance}`);
      return;
    }

    const isError = message.is_error === true;
    const status: TurnStatus =
      active.forced?.status ?? (active.interruptRequested ? "interrupted" : isError ? "failed" : "completed");
    const text = typeof message.result === "string" && message.result.length > 0 ? message.result : active.streamed;
    this.hub.emit({ type: "turn-completed", turnId: active.turnId, status });
    active.done.resolve(
      this.result(active, status, active.forced?.error ?? (status === "failed" ? errorText(message, text) : undefined), text, message.structured_output),
    );
  }

  private result(
    active: ActiveTurn,
    status: TurnStatus,
    error?: string,
    text: string = active.streamed,
    structuredOutput?: unknown,
  ): TurnResult {
    let structured = structuredOutput;
    if (structured === undefined && active.structuredSchema && status === "completed") {
      structured = tryParseJson(text);
    }
    return {
      turnId: active.turnId,
      status,
      text,
      ...(structured !== undefined ? { structured } : {}),
      ...(Object.keys(active.usage).length > 0 ? { usage: active.usage } : {}),
      durationMs: Date.now() - active.startedAt,
      ...(error ? { error } : {}),
    };
  }
}

function mergeUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const entries = {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    cachedInputTokens: sum(a.cachedInputTokens, b.cachedInputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    reportedCostUsd: sum(a.reportedCostUsd, b.reportedCostUsd),
  };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as AgentUsage;
}

function toolSummary(input: Json): string | undefined {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 300);
  }
  return undefined;
}

function errorText(message: Json, text: string): string {
  return JSON.stringify({ subtype: message.subtype, message: text.slice(0, 500) });
}

function promptWithSchema(prompt: string, schema: Record<string, unknown>): string {
  return `${prompt}\n\nRespond with a single JSON document and nothing else. It must satisfy this JSON Schema:\n${JSON.stringify(schema)}`;
}

function tryParseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [text.trim(), fenced?.[1]?.trim()]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
