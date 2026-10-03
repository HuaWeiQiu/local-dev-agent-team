import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { finished } from "node:stream/promises";
import path from "node:path";
import type { AgentRunResult } from "../adapters/types.js";
import type { AgentProfile } from "../config/schema.js";
import { OperatorInterruptError, type LiveAgentRegistry } from "../interventions/registry.js";
import { beginLiveChild } from "../process/live-children.js";
import { resolveAgentTeamStateRoot } from "../process/state-root.js";
import {
  classifyProviderFailure,
  ProviderFailureError,
} from "../providers/failure.js";
import {
  SessionError,
  type AgentSession,
  type SessionEvent,
  type SessionFactory,
  type TurnResult,
} from "../sessions/index.js";

export interface LiveSupport {
  factory: SessionFactory;
  registry: LiveAgentRegistry;
}

export interface LiveInvokeOptions {
  support: LiveSupport;
  adapterName: string;
  profileName: string;
  profile: AgentProfile;
  cwd: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  artifactDirectory: string;
  runId: string;
  role: string;
  artifactKey: string;
  taskId?: string;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onSessionEvent?: (event: SessionEvent) => void;
}

/** Redirects after an operator interrupt are bounded so a loop cannot burn the budget. */
const MAX_REDIRECTS = 5;

/**
 * Runs one role invocation through a live agent session. Returns the same
 * result shape as a one-shot invocation so budgets, usage and fallback chains
 * keep working unchanged.
 */
export async function invokeLive(options: LiveInvokeOptions): Promise<AgentRunResult> {
  const { support, profile } = options;
  await mkdir(options.artifactDirectory, { recursive: true });
  const executable = profile.executable ?? options.adapterName;
  const session = await support.factory.open({
    adapterName: options.adapterName,
    profile,
    cwd: options.cwd,
    runId: options.runId,
    artifactDirectory: options.artifactDirectory,
    ...(options.outputSchema ? { sessionSchema: options.outputSchema } : {}),
    liveChild: beginLiveChild(resolveAgentTeamStateRoot(options.cwd), {
      command: executable,
      cwd: options.cwd,
      runId: options.runId,
    }),
  });
  const handle = support.registry.attach(
    {
      runId: options.runId,
      role: options.role,
      artifactKey: options.artifactKey,
      ...(options.taskId ? { taskId: options.taskId } : {}),
      profile: options.profileName,
      adapter: options.adapterName,
      model: profile.model,
    },
    session,
  );
  const log = createWriteStream(path.join(options.artifactDirectory, "stdout.log"), { flags: "w" });
  const events = createWriteStream(path.join(options.artifactDirectory, "session.jsonl"), { flags: "w" });
  const unsubscribe = session.onEvent((event) => {
    if (event.type === "text-delta") {
      log.write(event.text);
      options.onText?.(event.text);
    } else {
      events.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    }
    options.onSessionEvent?.(event);
  });
  const startedAt = Date.now();
  try {
    const result = await runWithRedirects(session, handle, options);
    return {
      text: result.text,
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      process: {
        command: executable,
        args: [],
        exitCode: 0,
        stdout: result.text,
        stderr: "",
        durationMs: Date.now() - startedAt,
        timedOut: false,
        signal: null,
      },
    };
  } finally {
    unsubscribe();
    handle.detach();
    log.end();
    events.end();
    await Promise.all([finished(log), finished(events)]).catch(() => undefined);
    await session.close().catch(() => undefined);
  }
}

async function runWithRedirects(
  session: AgentSession,
  handle: { takeInterrupt(): { actor: string; note?: string } | undefined },
  options: LiveInvokeOptions,
): Promise<TurnResult> {
  let prompt = options.prompt;
  const timeoutMs = options.profile.timeoutSeconds * 1000;
  for (let redirect = 0; ; redirect += 1) {
    const result = await session.runTurn({
      prompt,
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs,
    });
    if (result.status === "completed") return result;
    if (result.status === "failed") {
      const message = result.error ?? "agent turn failed";
      throw new ProviderFailureError(
        message,
        classifyProviderFailure({ message, stdout: result.text }),
        options.profileName,
        options.adapterName,
        options.profile.model,
      );
    }
    options.signal?.throwIfAborted();
    const directive = handle.takeInterrupt();
    if (!directive) {
      throw new SessionError("agent turn was interrupted unexpectedly", "protocol");
    }
    if (directive.note === undefined) {
      throw new OperatorInterruptError(directive.actor, options.role);
    }
    if (redirect >= MAX_REDIRECTS) {
      throw new OperatorInterruptError(directive.actor, options.role);
    }
    prompt = `The operator interrupted your previous turn with this instruction. Follow it now, keeping the original task and output format.\n\n${directive.note}`;
  }
}
