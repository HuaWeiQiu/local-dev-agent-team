import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { codexProviderArguments } from "../adapters/codex.js";
import type { AgentUsage } from "../adapters/types.js";
import type { AgentProfile } from "../config/schema.js";
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

/** The app-server command line: isolation flags first, then profile overrides. */
export function appServerArguments(profile: AgentProfile, cwd: string): string[] {
  const args = ["app-server"];
  if (profile.externalTools === "deny") {
    args.push(
      "-c",
      "project_root_markers=[]",
      "-c",
      `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`,
    );
  }
  if (profile.codexProvider) args.push(...codexProviderArguments(profile.codexProvider));
  if (profile.nativeProfile) args.push("-c", `profile=${JSON.stringify(profile.nativeProfile)}`);
  return args;
}

/** Close the pipe first, then the process; wait for it to be gone. */
async function stopProcess(proc: StreamProcess | undefined): Promise<void> {
  if (!proc) return;
  proc.closeStdin();
  proc.terminate();
  await proc.exited;
}

async function removeIsolatedHome(home: string | undefined): Promise<void> {
  if (!home) return;
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

/** One JSON-RPC line, or undefined when it is not JSON at all. */
function decodeLine(line: string): Json | undefined {
  try {
    return JSON.parse(line) as Json;
  } catch {
    return undefined;
  }
}

/** The reason text for an exited app server. */
function exitReason(
  spawnError: Error | undefined,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): string {
  if (spawnError) return `could not start codex: ${spawnError.message}`;
  const code = exitCode ?? "none";
  const signalText = signal ? `, ${signal}` : "";
  return `codex app-server exited (code ${code}${signalText}): ${stderrTail.slice(-400)}`;
}

interface CompletedTurn {
  id?: string;
  status?: string;
  error?: { message?: string } | null;
  items?: Json[];
}

/** A completion for a different turn leaves the current one alone. */
function belongsToAnotherTurn(active: ActiveTurn, turn: CompletedTurn | undefined): boolean {
  return Boolean(active.turnId && turn?.id && turn.id !== active.turnId);
}

function turnStatus(raw: string | undefined): TurnStatus {
  if (raw === "completed") return "completed";
  return raw === "interrupted" ? "interrupted" : "failed";
}

/** The last agent message becomes the turn's answer when none was streamed. */
function adoptFinalItem(active: ActiveTurn, items: Json[] | undefined): void {
  if (active.finalText !== undefined) return;
  const finals = (items ?? []).filter((item) => item.type === "agentMessage");
  const last = finals[finals.length - 1];
  if (last) active.finalText = String(last.text ?? "");
}

interface ActiveTurn {
  turnId: string | undefined;
  done: Deferred<TurnResult>;
  startedAt: number;
  finalText: string | undefined;
  lastText: string;
  usageBaseline: AgentUsage;
  structured: boolean;
}

interface PendingQuestion {
  requestId: number | string;
  turnId: string;
  questionIds: string[];
  answers: Map<string, string>;
}

const REQUEST_TIMEOUT_MS = 60_000;
const INTERRUPT_GRACE_MS = 5_000;

/** Item kinds that carry no tool information worth showing. */
const IGNORED_ITEM_TYPES = new Set([
  "userMessage",
  "reasoning",
  "hookPrompt",
  "contextCompaction",
]);

/** A completed item is only failed when the server says so. */
function toolStatus(completed: boolean, item: Json): "started" | "failed" | "completed" {
  if (!completed) return "started";
  return item.status === "failed" || item.status === "declined" ? "failed" : "completed";
}

type NotificationHandler = (session: CodexAppServerSession, params: Json) => void;

/** App-server notifications, one handler per method. */
const NOTIFICATIONS: Record<string, NotificationHandler> = {
  "turn/started": (session, params) => session.startTurn(params),
  "item/agentMessage/delta": (session, params) => session.emitDelta(params),
  "item/started": (session, params) => session.handleItem(false, params),
  "item/completed": (session, params) => session.handleItem(true, params),
  "thread/tokenUsage/updated": (session, params) => session.handleUsage(params),
  "turn/completed": (session, params) => session.handleTurnCompleted(params),
  error: (session, params) =>
    session.emitNotice("error", errorText(params) ?? "app-server error"),
  warning: (session, params) => session.emitNotice("warning", String(params.message ?? "")),
};

function errorText(params: Json): string | undefined {
  const error = params.error as { message?: string } | undefined;
  return error?.message;
}

type ServerReply = (session: CodexAppServerSession, id: number | string, params: Json) => void;

/** Every request the app server may send us, and the one answer we give. */
const SERVER_REPLIES: Record<string, ServerReply> = {
  "item/tool/requestUserInput": (session, id, params) => session.requestUserInput(id, params),
  "item/commandExecution/requestApproval": (session, id, _params) =>
    session.declineApproval(id, "item/commandExecution/requestApproval"),
  "item/fileChange/requestApproval": (session, id, _params) =>
    session.declineApproval(id, "item/fileChange/requestApproval"),
  applyPatchApproval: (session, id) => session.respond(id, { decision: "denied" }),
  execCommandApproval: (session, id) => session.respond(id, { decision: "denied" }),
  "item/permissions/requestApproval": (session, id) => session.respond(id, { permissions: {} }),
  "mcpServer/elicitation/request": (session, id) => session.respond(id, { action: "decline" }),
};

/** One session event per question the app server asked. */
function questionEvent(
  turnId: string,
  questionId: string,
  question: Json,
): Parameters<SessionEventHub["emit"]>[0] {
  const options = (question.options as Json[] | null | undefined)?.map((o) => String(o.label));
  return {
    type: "question",
    turnId,
    questionId,
    prompt: String(question.question ?? question.header ?? ""),
    ...(options && options.length > 0 ? { options } : {}),
    ...(question.isSecret === true ? { secret: true } : {}),
  };
}

export class CodexAppServerSession implements AgentSession {
  readonly kind = "codex-app-server" as const;
  readonly capabilities: SessionCapabilities;
  private readonly hub = new SessionEventHub();
  private readonly pending = new Map<number, Deferred<unknown>>();
  private readonly questions = new Map<string, PendingQuestion>();
  private proc: StreamProcess | undefined;
  private starting: Promise<void> | undefined;
  private nextId = 0;
  private threadId: string | undefined;
  private active: ActiveTurn | undefined;
  private totals: AgentUsage = {};
  private codexHome: string | undefined;
  private closed = false;
  private dead: SessionError | undefined;

  constructor(
    private readonly options: OpenSessionOptions,
    private readonly command: string,
  ) {
    this.capabilities = {
      steer: true,
      interrupt: true,
      askUser: true,
      resume: options.profile.externalTools === "inherit",
    };
  }

  get nativeSessionId(): string | undefined {
    return this.threadId;
  }

  onEvent(listener: SessionEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    if (this.closed) throw new SessionError("session is closed", "closed");
    if (this.dead) throw this.dead;
    if (this.active) throw new SessionError("a turn is already running", "protocol");
    input.signal?.throwIfAborted();
    await this.ensureStarted();

    const active: ActiveTurn = {
      turnId: undefined,
      done: new Deferred<TurnResult>(),
      startedAt: Date.now(),
      finalText: undefined,
      lastText: "",
      usageBaseline: { ...this.totals },
      structured: input.outputSchema !== undefined,
    };
    this.active = active;

    const onAbort = (): void => {
      void this.interruptWithGrace(active, "interrupted");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = input.timeoutMs
      ? setTimeout(() => {
          void this.interruptWithGrace(active, "failed", `turn exceeded ${input.timeoutMs}ms`);
        }, input.timeoutMs)
      : undefined;

    try {
      const response = (await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        effort: this.options.profile.reasoning,
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      })) as { turn?: { id?: string } };
      active.turnId ??= response.turn?.id;
      return await active.done.promise;
    } catch (error) {
      active.done.reject(error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (this.active === active) this.active = undefined;
    }
  }

  async steer(text: string): Promise<void> {
    const active = this.requireActiveTurn();
    await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: active.turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interrupt(): Promise<void> {
    const active = this.requireActiveTurn();
    await this.request("turn/interrupt", { threadId: this.threadId, turnId: active.turnId });
  }

  async answer(questionId: string, answer: string): Promise<void> {
    const question = this.questions.get(questionId);
    if (!question) throw new SessionError(`unknown question '${questionId}'`, "not-running");
    question.answers.set(questionId, answer);
    if (question.questionIds.every((id) => question.answers.has(id))) {
      const answers: Record<string, { answers: string[] }> = {};
      for (const id of question.questionIds) {
        const key = id.slice(id.indexOf(":") + 1);
        answers[key] = { answers: [question.answers.get(id) ?? ""] };
        this.questions.delete(id);
      }
      this.respond(question.requestId, { answers });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    this.rejectOutstanding();
    await stopProcess(proc);
    await removeIsolatedHome(this.codexHome);
  }

  /** Nobody is left to answer: fail the active turn and every waiter. */
  rejectOutstanding(): void {
    const error = new SessionError("session closed", "closed");
    this.active?.done.reject(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private requireActiveTurn(): ActiveTurn {
    if (!this.active?.turnId || !this.threadId) {
      throw new SessionError("no turn is running", "not-running");
    }
    return this.active;
  }

  private async interruptWithGrace(
    active: ActiveTurn,
    status: TurnStatus,
    error?: string,
  ): Promise<void> {
    try {
      if (active.turnId && this.threadId) {
        await this.request("turn/interrupt", { threadId: this.threadId, turnId: active.turnId });
      }
    } catch {
      // Fall through to the forced resolution below.
    }
    const grace = setTimeout(() => {
      active.done.resolve(this.buildResult(active, status, error));
    }, INTERRUPT_GRACE_MS);
    grace.unref();
    void active.done.promise.finally(() => clearTimeout(grace)).catch(() => undefined);
  }

  private ensureStarted(): Promise<void> {
    this.starting ??= this.start();
    return this.starting;
  }

  private async start(): Promise<void> {
    const { profile, cwd } = this.options;
    const env = { ...(this.options.env ?? sanitizedChildEnv()) };
    if (profile.externalTools === "deny") {
      // Equivalent of `codex exec --ignore-user-config`: no user config,
      // skills, plugins or MCP servers; credentials are only referenced.
      this.codexHome = await createIsolatedCodexHome(env);
      env.CODEX_HOME = this.codexHome;
    }

    const args = appServerArguments(profile, cwd);

    const proc = spawnStreamProcess({
      command: this.command,
      args,
      cwd,
      env,
      onLine: (line) => this.handleLine(line),
      ...(this.options.liveChild ? { liveChild: this.options.liveChild } : {}),
    });
    this.proc = proc;
    void proc.exited.then((exit) => this.handleExit(exit.exitCode, exit.signal, exit.error));

    await this.request("initialize", {
      clientInfo: { name: "agent-team", title: "Agent Team", version: "2" },
    });
    this.notify("initialized");

    const threadParams = {
      cwd,
      approvalPolicy: "never",
      sandbox: profile.permission,
      ...(profile.model !== "inherit" ? { model: profile.model } : {}),
    };
    const resumeId = this.options.resumeSessionId;
    const response = (await (resumeId
      ? this.request("thread/resume", { threadId: resumeId, ...threadParams })
      : this.request("thread/start", { ...threadParams, ephemeral: !this.capabilities.resume }))) as {
      thread?: { id?: string };
    };
    this.threadId = response.thread?.id ?? resumeId;
    if (!this.threadId) throw new SessionError("codex did not return a thread id", "protocol");
  }

  private request(method: string, params: Json): Promise<unknown> {
    const proc = this.proc;
    if (this.dead) return Promise.reject(this.dead);
    if (!proc) return Promise.reject(new SessionError("process not started", "not-running"));
    const id = ++this.nextId;
    const waiter = new Deferred<unknown>();
    this.pending.set(id, waiter);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      waiter.reject(new SessionError(`codex request '${method}' timed out`, "timeout"));
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    proc.write(JSON.stringify({ id, method, params }));
    return waiter.promise.finally(() => clearTimeout(timer));
  }

  private notify(method: string): void {
    this.proc?.write(JSON.stringify({ method }));
  }

  respond(id: number | string, result: unknown): void {
    this.proc?.write(JSON.stringify({ id, result }));
  }

  private respondError(id: number | string, message: string): void {
    this.proc?.write(JSON.stringify({ id, error: { code: -32601, message } }));
  }

  private handleLine(line: string): void {
    const message = decodeLine(line);
    if (!message) {
      this.hub.emit({
        type: "notice",
        level: "warning",
        message: `unparseable app-server line: ${line.slice(0, 120)}`,
      });
      return;
    }
    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;
    if (method === undefined && id !== undefined) {
      const waiter = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!waiter) return;
      this.pending.delete(id as number);
      if (message.error) {
        const error = message.error as { message?: string };
        waiter.reject(new SessionError(error.message ?? "app-server error", "protocol"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (method === undefined) return;
    const params = (message.params ?? {}) as Json;
    if (id !== undefined) {
      this.handleServerRequest(id, method, params);
    } else {
      this.handleNotification(method, params);
    }
  }

  private handleServerRequest(id: number | string, method: string, params: Json): void {
    const reply = SERVER_REPLIES[method];
    if (!reply) {
      this.respondError(id, `unsupported server request '${method}'`);
      return;
    }
    reply(this, id, params);
  }

  /** Ask the operator and remember the pending questions until answered. */
  requestUserInput(id: number | string, params: Json): void {
    const turnId = String(params.turnId ?? this.active?.turnId ?? "");
    const questions = (params.questions as Json[] | undefined) ?? [];
    const questionIds = questions.map((q) => `${id}:${String(q.id)}`);
    const pending: PendingQuestion = { requestId: id, turnId, questionIds, answers: new Map() };
    for (const [index, question] of questions.entries()) {
      const questionId = questionIds[index]!;
      this.questions.set(questionId, pending);
      this.hub.emit(questionEvent(turnId, questionId, question));
    }
  }

  /** Approvals are never granted automatically: refuse and say so. */
  declineApproval(id: number | string, method: string): void {
    this.respond(id, { decision: "decline" });
    this.hub.emit({
      type: "notice",
      level: "warning",
      message: `declined ${method}: approvals are never granted automatically`,
    });
  }

  private handleNotification(method: string, params: Json): void {
    const handler = NOTIFICATIONS[method];
    if (handler) handler(this, params);
  }

  startTurn(params: Json): void {
    const active = this.active;
    const turn = params.turn as { id?: string } | undefined;
    if (!active || !turn?.id) return;
    active.turnId ??= turn.id;
    this.hub.emit({ type: "turn-started", turnId: turn.id });
  }

  emitDelta(params: Json): void {
    const active = this.active;
    if (!active) return;
    this.hub.emit({
      type: "text-delta",
      turnId: String(params.turnId ?? active.turnId ?? ""),
      text: String(params.delta ?? ""),
    });
  }

  emitNotice(level: "info" | "warning" | "error", message: string): void {
    this.hub.emit({ type: "notice", level, message });
  }

  handleItem(completed: boolean, params: Json): void {
    const active = this.active;
    const item = params.item as Json | undefined;
    if (!active || !item) return;
    const turnId = String(params.turnId ?? active.turnId ?? "");
    const type = String(item.type);
    if (type === "agentMessage") {
      this.agentMessageItem(completed, item, turnId);
      return;
    }
    if (IGNORED_ITEM_TYPES.has(type)) return;
    this.toolItem(completed, item, turnId);
  }

  /** A completed agent message is the turn's answer; only a final phase is final. */
  agentMessageItem(completed: boolean, item: Json, turnId: string): void {
    if (!completed) return;
    const text = String(item.text ?? "");
    const active = this.active!;
    active.lastText = text;
    if (item.phase === "final_answer") active.finalText = text;
    this.hub.emit({ type: "message", turnId, text, final: item.phase === "final_answer" });
  }

  toolItem(completed: boolean, item: Json, turnId: string): void {
    const type = String(item.type);
    const summary = toolSummary(type, item);
    this.hub.emit({
      type: "tool",
      turnId,
      toolId: String(item.id),
      name: toolName(type, item),
      status: toolStatus(completed, item),
      ...(summary ? { summary } : {}),
    });
  }

  handleUsage(params: Json): void {
    const total = (params.tokenUsage as { total?: Json } | undefined)?.total;
    if (!total) return;
    this.totals = totalsFrom(total);
    const active = this.active;
    if (!active) return;
    this.hub.emit({
      type: "usage",
      turnId: String(params.turnId ?? active.turnId ?? ""),
      usage: usageDelta(this.totals, active.usageBaseline),
    });
  }

  handleTurnCompleted(params: Json): void {
    const active = this.active;
    if (!active) return;
    const turn = params.turn as CompletedTurn | undefined;
    if (belongsToAnotherTurn(active, turn)) return;
    const status = turnStatus(turn?.status);
    adoptFinalItem(active, turn?.items);
    const error = status === "failed" ? JSON.stringify(turn?.error ?? { message: "turn failed" }) : undefined;
    this.settleTurn(active, status, turn?.id ?? active.turnId ?? "", error);
  }

  /** Announce the completed turn and resolve the waiting caller. */
  settleTurn(active: ActiveTurn, status: TurnStatus, turnId: string, error: string | undefined): void {
    this.hub.emit({ type: "turn-completed", turnId, status });
    active.done.resolve(this.buildResult(active, status, error));
  }

  private buildResult(active: ActiveTurn, status: TurnStatus, error?: string): TurnResult {
    const text = active.finalText ?? active.lastText;
    let structured: unknown;
    if (active.structured && status === "completed") {
      try {
        structured = JSON.parse(text);
      } catch {
        structured = undefined;
      }
    }
    const usage = usageDelta(this.totals, active.usageBaseline);
    return {
      turnId: active.turnId ?? "",
      status,
      text,
      ...(structured !== undefined ? { structured } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      durationMs: Date.now() - active.startedAt,
      ...(error ? { error } : {}),
    };
  }

  private handleExit(exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void {
    if (this.closed) return;
    const reason = exitReason(
      spawnError,
      exitCode,
      signal,
      this.proc?.stderrTail() ?? "",
    );
    const error = new SessionError(reason, "process-exit");
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.active?.done.reject(error);
    this.dead = error;
  }
}

function usageDelta(current: AgentUsage, baseline: AgentUsage): AgentUsage {
  const result: AgentUsage = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
    const value = current[key];
    if (value === undefined) continue;
    const delta = value - (baseline[key] ?? 0);
    if (delta > 0) result[key] = delta;
  }
  return result;
}

function toolName(type: string, item: Json): string {
  if (type === "mcpToolCall") return `mcp:${String(item.server)}/${String(item.tool)}`;
  if (type === "dynamicToolCall") return String(item.tool ?? "tool");
  return type;
}

/** Token totals as the app server reports them; missing counters read as zero. */
export function totalsFrom(total: Json): AgentUsage {
  return {
    inputTokens: Number(total.inputTokens ?? 0),
    cachedInputTokens: Number(total.cachedInputTokens ?? 0),
    outputTokens: Number(total.outputTokens ?? 0),
  };
}

const TOOL_SUMMARIES: Record<string, (item: Json) => string | undefined> = {
  commandExecution: (item) => clipped(item.command),
  webSearch: (item) => clipped(item.query),
  fileChange: (item) => changedPaths(item.changes),
};

/** A tool's one-line summary: the command, the query, or the changed paths. */
export function toolSummary(type: string, item: Json): string | undefined {
  return TOOL_SUMMARIES[type]?.(item);
}

function clipped(value: unknown): string | undefined {
  return String(value ?? "").slice(0, 300) || undefined;
}

function changedPaths(changes: unknown): string | undefined {
  if (!Array.isArray(changes)) return undefined;
  const paths = changes
    .map((change) => String((change as Json).path ?? ""))
    .filter(Boolean)
    .slice(0, 8);
  return paths.length > 0 ? paths.join(", ") : undefined;
}

async function createIsolatedCodexHome(env: NodeJS.ProcessEnv): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-team-codex-"));
  const realHome = env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const auth = path.join(realHome, "auth.json");
  if (await lstat(auth).then(() => true, () => false)) {
    await symlink(auth, path.join(directory, "auth.json"));
  }
  await writeFile(path.join(directory, "config.toml"), "");
  return directory;
}
