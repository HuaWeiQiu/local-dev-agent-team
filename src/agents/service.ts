import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { z } from "zod";
import type { AgentTeamConfig } from "../config/schema.js";
import { fallbackProfiles, resolveProfile, type ResolvedProfile } from "../profiles/resolve.js";
import { AgentInvocationError, invokeAgent, type InvokeOptions } from "../adapters/invoke.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { adapterRoleWarning, assertAdapterProfile } from "../adapters/conformance.js";
import { invokeLive, type LiveInvokeOptions, type LiveSupport } from "./live-invoke.js";
import { DEFAULT_MAX_STALL_RECOVERIES, DEFAULT_STALL_SECONDS } from "../reliability/stall.js";
import { OperatorInterruptError } from "../interventions/registry.js";
import type { AgentActivitySnapshot, AgentRunResult } from "../adapters/types.js";
import type { RunStateStore } from "../state/store.js";
import { assertRoleProfilePermission } from "../security/permissions.js";
import {
  classificationForCode,
  classifyError,
  defaultProviderHealthRegistry,
  type ProviderFailureAttempt,
  type ProviderFailureClassification,
  type ProviderHealthRegistry,
  RoleProfileChainError,
} from "../providers/failure.js";

export interface RoleInvocationOptions<T> {
  role: string;
  context: unknown;
  runId: string;
  artifactKey: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  profileName?: string;
  cwd?: string;
  promptKey?: string;
}

export interface TextRoleInvocationOptions {
  role: string;
  context: unknown;
  runId: string;
  artifactKey: string;
  profileName?: string;
  cwd?: string;
  promptKey?: string;
}

export interface RoleResponse<T> {
  value: T;
  profileName: string;
  usedFallback: boolean;
  text: string;
}

export interface TextRoleResponse {
  text: string;
  profileName: string;
  usedFallback: boolean;
}

export interface RoleAgentService {
  runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>>;
  runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse>;
}

export interface AgentInvocationObservation {
  invocationId: string;
  runId: string;
  role: string;
  profile: string;
  adapter: string;
  model: string;
  permission: string;
  externalTools: string;
  artifactKey: string;
  durationMs: number;
  result?: AgentRunResult;
  error?: unknown;
}

export interface AgentInvocationObserver {
  readonly maxProcessOutputBytes?: number;
  beforeInvocation(
    observation: Omit<AgentInvocationObservation, "invocationId" | "durationMs" | "result" | "error">,
  ): Promise<string>;
  afterInvocation(observation: AgentInvocationObservation): Promise<void>;
}

/** What one invocation returns once a candidate succeeded. */
interface InvocationResponse {
  text: string;
  structured?: unknown;
  profileName: string;
  usedFallback: boolean;
}

/** The decisions made before any profile is attempted. */
interface InvocationPlan {
  candidates: ResolvedProfile[];
  prompt: string;
}

/** Everything one candidate attempt needs that the chain decided up front. */
interface CandidateRequest {
  options: TextRoleInvocationOptions;
  outputSchema: Record<string, unknown> | undefined;
  candidate: ResolvedProfile;
  prompt: string;
  /** The candidate after this one, or null when this attempt ends the chain. */
  nextProfile: string | null;
}

/** A candidate either produced the response or left an attempt for the chain error. */
type CandidateOutcome =
  | { kind: "invoked"; response: InvocationResponse }
  | { kind: "exhausted"; attempt: ProviderFailureAttempt };

/** Per-attempt bookkeeping: whether an invocation id exists and whether it was reported. */
interface AttemptState {
  invocationId: string | undefined;
  observed: boolean;
  observationFailed: boolean;
  startedAt: number;
}

type AttemptGate = ReturnType<ProviderHealthRegistry["allowAttempt"]>;

type ObservationDetail = Partial<Pick<AgentInvocationObservation, "result" | "error">>;

export class ProfiledAgentService implements RoleAgentService {
  constructor(
    private readonly config: AgentTeamConfig,
    private readonly root: string,
    private readonly store: RunStateStore,
    private readonly profileOverrides: Record<string, string>,
    private readonly signal?: AbortSignal,
    private readonly observer?: AgentInvocationObserver,
    private readonly registry = new AdapterRegistry(),
    private readonly health: ProviderHealthRegistry = defaultProviderHealthRegistry,
    private readonly live?: LiveSupport,
  ) {}

  async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
    const response = await this.invoke(options, options.jsonSchema);
    const candidate = response.structured ?? parseJsonText(response.text);
    const parsed = options.schema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `${options.role} returned invalid structured output: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return { ...response, value: parsed.data };
  }

  async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
    const response = await this.invoke(options);
    return {
      text: response.text,
      profileName: response.profileName,
      usedFallback: response.usedFallback,
    };
  }

  /**
   * One invocation: decide the candidate chain up front, then let each candidate
   * resolve to a response or to a recorded attempt. The chain stops at the first
   * response and reports every attempt when no candidate produced one.
   */
  private async invoke(
    options: TextRoleInvocationOptions,
    outputSchema?: Record<string, unknown>,
  ): Promise<InvocationResponse> {
    const plan = await this.planInvocation(options);
    const attempts: ProviderFailureAttempt[] = [];
    for (const [index, candidate] of plan.candidates.entries()) {
      const outcome = await this.attemptCandidate({
        options,
        outputSchema,
        candidate,
        prompt: plan.prompt,
        nextProfile: plan.candidates[index + 1]?.name ?? null,
      });
      if (outcome.kind === "invoked") return outcome.response;
      attempts.push(outcome.attempt);
    }
    throw new RoleProfileChainError(options.role, attempts);
  }

  /** Decides which profiles may run and in what order, then renders the prompt. */
  private async planInvocation(options: TextRoleInvocationOptions): Promise<InvocationPlan> {
    const candidates = candidateChain(this.config, this.profileOverrides, options);
    const prompt = await this.renderPrompt(
      options.role,
      options.promptKey ?? options.role,
      options.context,
    );
    return { candidates, prompt };
  }

  /** One candidate: check it is permitted, its circuit is closed, its artifacts exist. */
  private async attemptCandidate(request: CandidateRequest): Promise<CandidateOutcome> {
    const { options, candidate } = request;
    assertRoleProfilePermission(
      options.role,
      candidate.name,
      candidate.profile.permission,
    );
    reportRoleProfileMismatch(options.role, candidate);
    const gate = this.health.allowAttempt(
      candidate.name,
      candidate.profile.adapter,
      candidate.profile.model,
    );
    if (!gate.allowed) return this.skipCandidate(request, gate);
    const artifactDirectory = await prepareArtifactDirectory(this.store, options, candidate.name);
    return await this.runCandidate(request, artifactDirectory);
  }

  /** An open circuit is recorded and emitted here, so the chain moves to the next profile. */
  private skipCandidate(request: CandidateRequest, gate: AttemptGate): CandidateOutcome {
    const { options, candidate } = request;
    const attempt = skippedAttempt(candidate, gate);
    this.store.emit(options.runId, "agent.profile.skipped", {
      role: options.role,
      profile: candidate.name,
      adapter: candidate.profile.adapter,
      model: candidate.profile.model,
      artifactKey: options.artifactKey,
      reason: gate.reason,
      health: gate.snapshot,
      failure: attempt.classification,
    });
    return { kind: "exhausted", attempt };
  }

  /** Runs one candidate and turns anything it throws into a recorded attempt. */
  private async runCandidate(
    request: CandidateRequest,
    artifactDirectory: string,
  ): Promise<CandidateOutcome> {
    const state: AttemptState = {
      invocationId: undefined,
      observed: false,
      observationFailed: false,
      startedAt: Date.now(),
    };
    try {
      const response = await this.executeCandidate(request, artifactDirectory, state);
      return { kind: "invoked", response };
    } catch (error) {
      return await this.failCandidate(request, state, error);
    }
  }

  /** The happy path, in order: observe, invoke, record health, report the outcome. */
  private async executeCandidate(
    request: CandidateRequest,
    artifactDirectory: string,
    state: AttemptState,
  ): Promise<InvocationResponse> {
    await this.beginObservation(request, state);
    const result = await this.invokeThroughAdapter(request, artifactDirectory, state);
    this.health.recordSuccess(
      request.candidate.name,
      request.candidate.profile.adapter,
      request.candidate.profile.model,
    );
    await this.endObservation(request, state, { result });
    return invocationResponse(request.candidate, result);
  }

  private async beginObservation(request: CandidateRequest, state: AttemptState): Promise<void> {
    try {
      state.invocationId = await this.observer?.beforeInvocation(invocationIdentity(request));
    } catch (error) {
      state.observationFailed = true;
      throw error;
    }
  }

  /** Reports an invocation outcome at most once; a failing observer stops the chain. */
  private async endObservation(
    request: CandidateRequest,
    state: AttemptState,
    observation: ObservationDetail,
  ): Promise<void> {
    const invocationId = state.invocationId;
    if (!invocationId) return;
    state.observed = true;
    try {
      await this.observer?.afterInvocation({
        invocationId,
        ...invocationIdentity(request),
        durationMs: Date.now() - state.startedAt,
        ...observation,
      });
    } catch (error) {
      state.observationFailed = true;
      throw error;
    }
  }

  /** Ends a failed attempt: report it, then either abort the chain or record it. */
  private async failCandidate(
    request: CandidateRequest,
    state: AttemptState,
    error: unknown,
  ): Promise<CandidateOutcome> {
    let failure = error;
    if (state.invocationId && !state.observed) {
      state.observed = true;
      try {
        await this.endObservation(request, state, failureDetail(error));
      } catch (observerError) {
        state.observationFailed = true;
        failure = observerError;
      }
    }
    this.signal?.throwIfAborted();
    if (stopsChain(failure, state)) throw failure;
    return { kind: "exhausted", attempt: this.recordCandidateFailure(request, failure) };
  }

  private recordCandidateFailure(
    request: CandidateRequest,
    failure: unknown,
  ): ProviderFailureAttempt {
    const { options, candidate } = request;
    const { classification, message } = failureSummary(failure);
    const attempt: ProviderFailureAttempt = {
      profile: candidate.name,
      adapter: candidate.profile.adapter,
      model: candidate.profile.model,
      classification,
      message,
      at: new Date().toISOString(),
    };
    const health = this.health.recordFailure(
      candidate.name,
      candidate.profile.adapter,
      candidate.profile.model,
      classification,
    );
    this.store.emit(options.runId, "agent.profile.failed", {
      role: options.role,
      profile: candidate.name,
      adapter: candidate.profile.adapter,
      model: candidate.profile.model,
      artifactKey: options.artifactKey,
      usedFallback: candidate.usedFallback,
      failure: classification,
      health,
      message,
      nextProfile: request.nextProfile,
    });
    return attempt;
  }

  /** Runs the adapter for one candidate and always flushes the stream batches. */
  private async invokeThroughAdapter(
    request: CandidateRequest,
    artifactDirectory: string,
    state: AttemptState,
  ): Promise<AgentRunResult> {
    const batcher = streamEventBatcher(this.store, request.options, request.candidate);
    try {
      return await this.dispatchToAdapter(
        request,
        artifactDirectory,
        batcher,
        state.invocationId,
      );
    } finally {
      batcher.flushAll();
    }
  }

  /** Decides whether this candidate runs as a live session or as one adapter call. */
  private async dispatchToAdapter(
    request: CandidateRequest,
    artifactDirectory: string,
    batcher: StreamEventBatcher,
    invocationId: string | undefined,
  ): Promise<AgentRunResult> {
    const live = await this.liveSession(request);
    if (!live) {
      return invokeAgent(
        this.oneShotInvocationOptions(request, artifactDirectory, batcher, invocationId),
        this.registry,
      );
    }
    assertAdapterProfile(
      this.registry.get(request.candidate.profile.adapter),
      request.candidate.profile,
      request.outputSchema !== undefined,
    );
    return invokeLive(this.liveInvocationOptions(request, artifactDirectory, batcher, live));
  }

  /** The live support to use, or undefined when this candidate has no live session. */
  private async liveSession(request: CandidateRequest): Promise<LiveSupport | undefined> {
    const support = this.live;
    if (!support) return undefined;
    const plan = await support.factory.plan(
      request.candidate.profile.adapter,
      request.candidate.profile,
      this.workingDirectory(request.options),
    );
    return plan.kind === "one-shot" ? undefined : support;
  }

  private workingDirectory(options: TextRoleInvocationOptions): string {
    return options.cwd ?? this.root;
  }

  /** The stall watchdog limits this run configured, or the defaults. */
  private stallLimits(): { stallSeconds: number; maxRecoveries: number } {
    return {
      stallSeconds: this.config.workflow?.stallSeconds ?? DEFAULT_STALL_SECONDS,
      maxRecoveries: this.config.workflow?.maxStallRecoveries ?? DEFAULT_MAX_STALL_RECOVERIES,
    };
  }

  private liveInvocationOptions(
    request: CandidateRequest,
    artifactDirectory: string,
    batcher: StreamEventBatcher,
    support: LiveSupport,
  ): LiveInvokeOptions {
    const { options, candidate, prompt } = request;
    const taskId = taskIdFromContext(options.context);
    return {
      support,
      adapterName: candidate.profile.adapter,
      profileName: candidate.name,
      profile: candidate.profile,
      cwd: this.workingDirectory(options),
      prompt,
      artifactDirectory,
      runId: options.runId,
      role: options.role,
      artifactKey: options.artifactKey,
      ...(taskId ? { taskId } : {}),
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      ...(this.signal ? { signal: this.signal } : {}),
      stall: this.stallLimits(),
      onText: (chunk) => {
        batcher.push("stdout", boundedOutputChunk(chunk));
      },
    };
  }

  private oneShotInvocationOptions(
    request: CandidateRequest,
    artifactDirectory: string,
    batcher: StreamEventBatcher,
    invocationId: string | undefined,
  ): InvokeOptions {
    const { options, candidate, prompt } = request;
    return {
      adapterName: candidate.profile.adapter,
      profile: candidate.profile,
      cwd: this.workingDirectory(options),
      runId: options.runId,
      prompt,
      artifactDirectory,
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      ...(this.signal ? { signal: this.signal } : {}),
      ...(this.observer?.maxProcessOutputBytes
        ? { maxOutputBytes: this.observer.maxProcessOutputBytes }
        : {}),
      onStdout: (chunk) => {
        batcher.push("stdout", boundedOutputChunk(chunk));
      },
      onStderr: (chunk) => {
        batcher.push("stderr", boundedOutputChunk(chunk));
      },
      ...(invocationId
        ? {
            onActivity: (activity: AgentActivitySnapshot) => {
              this.emitChildActivity(options, candidate, invocationId, activity);
            },
          }
        : {}),
    };
  }

  private emitChildActivity(
    options: TextRoleInvocationOptions,
    candidate: ResolvedProfile,
    invocationId: string,
    activity: AgentActivitySnapshot,
  ): void {
    this.store.emit(options.runId, "agent.children.updated", {
      invocationId,
      role: options.role,
      profile: candidate.name,
      adapter: candidate.profile.adapter,
      artifactKey: options.artifactKey,
      agents: activity.agents,
    });
  }

  private async renderPrompt(role: string, promptKey: string, context: unknown): Promise<string> {
    const rolePolicy = this.config.roles[role];
    if (!rolePolicy) {
      throw new Error(`Unknown role '${role}'`);
    }
    const defaultNames: Record<string, string> = {
      orchestrator: "orchestrator-intake.md",
      architect: "architect.md",
      researcher: "researcher.md",
      worker: "worker.md",
      reviewer: "reviewer.md",
      tester: "tester.md",
      "orchestrator-final": "orchestrator-final.md",
      "architect-advisor": "architect-advisor.md",
    };
    // The advisor is a distinct task of the architect role; a role-level
    // promptFile (written for planning) must not replace its instructions.
    const promptPath = rolePolicy.promptFile && promptKey !== "architect-advisor"
      ? path.resolve(this.root, rolePolicy.promptFile)
      : fileURLToPath(
          new URL(`../../prompts/${defaultNames[promptKey] ?? `${promptKey}.md`}`, import.meta.url),
        );
    const instructions = await loadPromptTemplate(promptPath);
    return `${instructions.trim()}\n\n## Run Context\n\n${JSON.stringify(context, null, 2)}\n`;
  }
}

/** The profile the caller asked for, then its fallbacks, without duplicate names. */
function candidateChain(
  config: AgentTeamConfig,
  profileOverrides: Record<string, string>,
  options: TextRoleInvocationOptions,
): ResolvedProfile[] {
  const requested = requestedProfileForRole(options.role, profileOverrides, options.profileName);
  const primary = resolveProfile(config, options.role, requested);
  return dedupeProfiles([primary, ...fallbackProfiles(config, options.role)]);
}

/** First occurrence wins: the primary profile beats a same-named fallback. */
function dedupeProfiles(profiles: ResolvedProfile[]): ResolvedProfile[] {
  const byName = new Map<string, ResolvedProfile>();
  for (const profile of profiles) {
    if (!byName.has(profile.name)) byName.set(profile.name, profile);
  }
  return [...byName.values()];
}

function reportRoleProfileMismatch(role: string, candidate: ResolvedProfile): void {
  const roleWarning = adapterRoleWarning(role, candidate.profile);
  if (roleWarning) {
    process.stderr.write(`Warning: ${roleWarning} (profile '${candidate.name}')\n`);
  }
}

async function prepareArtifactDirectory(
  store: RunStateStore,
  options: TextRoleInvocationOptions,
  profileName: string,
): Promise<string> {
  const directory = store.artifactDirectory(options.runId, options.artifactKey, profileName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "context.json"),
    `${JSON.stringify(options.context, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function streamEventBatcher(
  store: RunStateStore,
  options: TextRoleInvocationOptions,
  candidate: ResolvedProfile,
): StreamEventBatcher {
  return new StreamEventBatcher({
    emit: (stream, chunk) => {
      store.emit(options.runId, `agent.${stream}`, {
        role: options.role,
        profile: candidate.name,
        artifactKey: options.artifactKey,
        chunk,
      });
    },
  });
}

function invocationResponse(
  candidate: ResolvedProfile,
  result: AgentRunResult,
): InvocationResponse {
  return {
    text: result.text,
    ...(result.structured !== undefined ? { structured: result.structured } : {}),
    profileName: candidate.name,
    usedFallback: candidate.usedFallback,
  };
}

function invocationIdentity(
  request: CandidateRequest,
): Omit<AgentInvocationObservation, "invocationId" | "durationMs" | "result" | "error"> {
  const { options, candidate } = request;
  return {
    runId: options.runId,
    role: options.role,
    profile: candidate.name,
    adapter: candidate.profile.adapter,
    model: candidate.profile.model,
    permission: candidate.profile.permission,
    externalTools: candidate.profile.externalTools,
    artifactKey: options.artifactKey,
  };
}

function failureDetail(error: unknown): ObservationDetail {
  return error instanceof AgentInvocationError ? { result: error.result, error } : { error };
}

function failureSummary(failure: unknown): {
  classification: ProviderFailureClassification;
  message: string;
} {
  const classification = failure instanceof AgentInvocationError
    ? failure.classification
    : classifyError(failure);
  const message = failure instanceof Error ? failure.message : String(failure);
  return { classification, message };
}

/** Observer and budget failures end the whole chain instead of moving to a fallback. */
function stopsChain(failure: unknown, state: AttemptState): boolean {
  return (
    state.observationFailed ||
    isBudgetExceeded(failure) ||
    failure instanceof OperatorInterruptError
  );
}

function skippedAttempt(
  candidate: ResolvedProfile,
  gate: AttemptGate,
): ProviderFailureAttempt {
  return {
    profile: candidate.name,
    adapter: candidate.profile.adapter,
    model: candidate.profile.model,
    classification: skippedClassification(candidate, gate),
    message: gate.reason ?? "circuit open",
    at: new Date().toISOString(),
  };
}

function skippedClassification(
  candidate: ResolvedProfile,
  gate: AttemptGate,
): ProviderFailureClassification {
  const lastCode = gate.snapshot.lastCode;
  if (lastCode) return classificationForCode(lastCode, ["circuit-open"]);
  const summary = gate.snapshot.lastSummary ??
    `Profile '${candidate.name}' circuit is open (${gate.reason ?? "cooldown"})`;
  return classifyError(new Error(summary));
}

function taskIdFromContext(context: unknown): string | undefined {
  const task = taskFromContext(context);
  return typeof task?.id === "string" ? task.id : undefined;
}

function taskFromContext(context: unknown): { id?: unknown } | undefined {
  return isRecord(context) ? (context as { task?: { id?: unknown } }).task : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBudgetExceeded(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "RUN_BUDGET_EXCEEDED";
}

export function requestedProfileForRole(
  role: string,
  profileOverrides: Record<string, string>,
  taskProfile?: string,
): string | undefined {
  return profileOverrides[role] ?? taskProfile;
}

function boundedOutputChunk(chunk: string): string {
  const maxCharacters = 64 * 1024;
  return chunk.length <= maxCharacters
    ? chunk
    : `${chunk.slice(0, maxCharacters)}\n[chunk truncated]`;
}

export type StreamKind = "stdout" | "stderr";

export interface StreamEventBatcherOptions {
  emit: (stream: StreamKind, chunk: string) => void;
  flushIntervalMs?: number;
  maxBufferedCharacters?: number;
  now?: () => number;
}

const defaultFlushIntervalMs = 200;
const defaultMaxBufferedCharacters = 64 * 1024;

export class StreamEventBatcher {
  private readonly buffers: Record<StreamKind, string[]> = { stdout: [], stderr: [] };
  private readonly bufferedCharacters: Record<StreamKind, number> = { stdout: 0, stderr: 0 };
  private readonly bufferStartedAt: Record<StreamKind, number> = { stdout: 0, stderr: 0 };
  private readonly flushIntervalMs: number;
  private readonly maxBufferedCharacters: number;
  private readonly now: () => number;

  constructor(private readonly options: StreamEventBatcherOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? defaultFlushIntervalMs;
    this.maxBufferedCharacters = options.maxBufferedCharacters ?? defaultMaxBufferedCharacters;
    this.now = options.now ?? Date.now;
  }

  push(stream: StreamKind, chunk: string): void {
    if (!chunk) return;
    const now = this.now();
    if (
      this.bufferedCharacters[stream] > 0 &&
      now - this.bufferStartedAt[stream] >= this.flushIntervalMs
    ) {
      this.flush(stream);
    }
    if (this.bufferedCharacters[stream] === 0) {
      this.bufferStartedAt[stream] = now;
    }
    this.buffers[stream].push(chunk);
    this.bufferedCharacters[stream] += chunk.length;
    if (this.bufferedCharacters[stream] >= this.maxBufferedCharacters) {
      this.flush(stream);
    }
  }

  flushAll(): void {
    this.flush("stdout");
    this.flush("stderr");
  }

  private flush(stream: StreamKind): void {
    if (this.bufferedCharacters[stream] === 0) return;
    const chunk = this.buffers[stream].join("");
    this.buffers[stream] = [];
    this.bufferedCharacters[stream] = 0;
    this.options.emit(stream, chunk);
  }
}

const promptTemplateCache = new Map<string, Promise<string>>();

export async function loadPromptTemplate(promptPath: string): Promise<string> {
  const cached = promptTemplateCache.get(promptPath);
  if (cached) return await cached;
  const pending = readFile(promptPath, "utf8").catch((error: unknown) => {
    promptTemplateCache.delete(promptPath);
    throw error;
  });
  promptTemplateCache.set(promptPath, pending);
  return await pending;
}

export function clearPromptTemplateCache(): void {
  promptTemplateCache.clear();
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return parseFencedJson(text);
  }
}

function parseFencedJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1] ? JSON.parse(fenced[1]) : rejectUnparsableOutput();
}

function rejectUnparsableOutput(): never {
  throw new Error("Agent output was not valid JSON");
}
