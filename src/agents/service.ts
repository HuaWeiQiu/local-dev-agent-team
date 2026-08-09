import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { z } from "zod";
import type { AgentTeamConfig } from "../config/schema.js";
import { fallbackProfiles, resolveProfile } from "../profiles/resolve.js";
import { AgentInvocationError, invokeAgent } from "../adapters/invoke.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { AgentRunResult } from "../adapters/types.js";
import type { RunStateStore } from "../state/store.js";
import { assertRoleProfilePermission } from "../security/permissions.js";

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

export class ProfiledAgentService implements RoleAgentService {
  constructor(
    private readonly config: AgentTeamConfig,
    private readonly root: string,
    private readonly store: RunStateStore,
    private readonly profileOverrides: Record<string, string>,
    private readonly signal?: AbortSignal,
    private readonly observer?: AgentInvocationObserver,
    private readonly registry = new AdapterRegistry(),
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

  private async invoke(
    options: TextRoleInvocationOptions,
    outputSchema?: Record<string, unknown>,
  ): Promise<{
    text: string;
    structured?: unknown;
    profileName: string;
    usedFallback: boolean;
  }> {
    const requested = requestedProfileForRole(
      options.role,
      this.profileOverrides,
      options.profileName,
    );
    const primary = resolveProfile(this.config, options.role, requested);
    const candidates = [primary, ...fallbackProfiles(this.config, options.role)].filter(
      (candidate, index, all) =>
        all.findIndex((other) => other.name === candidate.name) === index,
    );
    const prompt = await this.renderPrompt(
      options.role,
      options.promptKey ?? options.role,
      options.context,
    );
    const errors: string[] = [];

    for (const candidate of candidates) {
      assertRoleProfilePermission(
        options.role,
        candidate.name,
        candidate.profile.permission,
      );
      const artifactDirectory = this.store.artifactDirectory(
        options.runId,
        options.artifactKey,
        candidate.name,
      );
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        path.join(artifactDirectory, "context.json"),
        `${JSON.stringify(options.context, null, 2)}\n`,
        "utf8",
      );
      let invocationId: string | undefined;
      let observed = false;
      let observationFailed = false;
      const startedAt = Date.now();
      try {
        try {
          invocationId = await this.observer?.beforeInvocation({
            runId: options.runId,
            role: options.role,
            profile: candidate.name,
            adapter: candidate.profile.adapter,
            model: candidate.profile.model,
            permission: candidate.profile.permission,
            externalTools: candidate.profile.externalTools,
            artifactKey: options.artifactKey,
          });
        } catch (error) {
          observationFailed = true;
          throw error;
        }
        const batcher = new StreamEventBatcher({
          emit: (stream, chunk) => {
            this.store.emit(options.runId, `agent.${stream}`, {
              role: options.role,
              profile: candidate.name,
              artifactKey: options.artifactKey,
              chunk,
            });
          },
        });
        let result;
        try {
          result = await invokeAgent(
            {
              adapterName: candidate.profile.adapter,
              profile: candidate.profile,
              cwd: options.cwd ?? this.root,
              prompt,
              artifactDirectory,
              ...(outputSchema ? { outputSchema } : {}),
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
            },
            this.registry,
          );
        } finally {
          batcher.flushAll();
        }
        if (invocationId) {
          observed = true;
          try {
            await this.observer?.afterInvocation({
              invocationId,
              runId: options.runId,
              role: options.role,
              profile: candidate.name,
              adapter: candidate.profile.adapter,
              model: candidate.profile.model,
              permission: candidate.profile.permission,
              externalTools: candidate.profile.externalTools,
              artifactKey: options.artifactKey,
              durationMs: Date.now() - startedAt,
              result,
            });
          } catch (error) {
            observationFailed = true;
            throw error;
          }
        }
        return {
          text: result.text,
          ...(result.structured !== undefined ? { structured: result.structured } : {}),
          profileName: candidate.name,
          usedFallback: candidate.usedFallback,
        };
      } catch (error) {
        let failure = error;
        if (invocationId && !observed) {
          observed = true;
          try {
            await this.observer?.afterInvocation({
              invocationId,
              runId: options.runId,
              role: options.role,
              profile: candidate.name,
              adapter: candidate.profile.adapter,
              model: candidate.profile.model,
              permission: candidate.profile.permission,
              externalTools: candidate.profile.externalTools,
              artifactKey: options.artifactKey,
              durationMs: Date.now() - startedAt,
              ...(error instanceof AgentInvocationError ? { result: error.result } : {}),
              error,
            });
          } catch (observerError) {
            observationFailed = true;
            failure = observerError;
          }
        }
        this.signal?.throwIfAborted();
        if (observationFailed || isBudgetExceeded(failure)) throw failure;
        errors.push(
          `${candidate.name}: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
    throw new Error(`All profiles failed for role '${options.role}':\n${errors.join("\n")}`);
  }

  private async renderPrompt(role: string, promptKey: string, context: unknown): Promise<string> {
    const rolePolicy = this.config.roles[role];
    if (!rolePolicy) {
      throw new Error(`Unknown role '${role}'`);
    }
    const defaultNames: Record<string, string> = {
      orchestrator: "orchestrator-intake.md",
      architect: "architect.md",
      worker: "worker.md",
      reviewer: "reviewer.md",
      tester: "tester.md",
      "orchestrator-final": "orchestrator-final.md",
    };
    const promptPath = rolePolicy.promptFile
      ? path.resolve(this.root, rolePolicy.promptFile)
      : fileURLToPath(
          new URL(`../../prompts/${defaultNames[promptKey] ?? `${promptKey}.md`}`, import.meta.url),
        );
    const instructions = await loadPromptTemplate(promptPath);
    return `${instructions.trim()}\n\n## Run Context\n\n${JSON.stringify(context, null, 2)}\n`;
  }
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
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }
    throw new Error("Agent output was not valid JSON");
  }
}
