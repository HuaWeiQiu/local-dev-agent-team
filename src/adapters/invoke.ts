import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import path from "node:path";
import type { AgentProfile } from "../config/schema.js";
import { beginLiveChild } from "../process/live-children.js";
import { runProcess } from "../process/run.js";
import { resolveAgentTeamStateRoot } from "../process/state-root.js";
import {
  classifyProviderFailure,
  type ProviderFailureClassification,
} from "../providers/failure.js";
import type { AgentActivitySnapshot, AgentAdapter, AgentRunResult } from "./types.js";
import { AdapterRegistry } from "./registry.js";
import { assertAdapterProfile, assertInvocationContract } from "./conformance.js";

export interface InvokeOptions {
  adapterName: string;
  profile: AgentProfile;
  cwd: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  artifactDirectory?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onActivity?: (activity: AgentActivitySnapshot) => void;
  maxOutputBytes?: number;
  runId?: string;
}

export class AgentInvocationError extends Error {
  override readonly name = "AgentInvocationError";
  readonly classification: ProviderFailureClassification;

  constructor(
    message: string,
    readonly result: AgentRunResult,
    options?: ErrorOptions & { classification?: ProviderFailureClassification },
  ) {
    super(message, options);
    this.classification =
      options?.classification ??
      classifyProviderFailure({
        message,
        stdout: result.process.stdout,
        stderr: result.process.stderr,
        exitCode: result.process.exitCode,
        timedOut: result.process.timedOut,
        signal: result.process.signal,
        cause: options?.cause,
      });
  }
}

export async function invokeAgent(
  options: InvokeOptions,
  registry = new AdapterRegistry(),
): Promise<AgentRunResult> {
  const adapter = registry.get(options.adapterName);
  assertAdapterProfile(adapter, options.profile, options.outputSchema !== undefined);
  const promptDirectory =
    adapter.promptTransport === "file"
      ? await mkdtemp(path.join(tmpdir(), "agent-team-prompt-"))
      : undefined;
  const promptFile = promptDirectory ? path.join(promptDirectory, "prompt.txt") : undefined;
  try {
    if (promptFile) {
      await writeFile(promptFile, options.prompt, { encoding: "utf8", mode: 0o600 });
    }
    return await invokePreparedAgent(options, adapter, promptFile);
  } finally {
    if (promptDirectory) {
      await rm(promptDirectory, { recursive: true, force: true });
    }
  }
}

async function invokePreparedAgent(
  options: InvokeOptions,
  adapter: AgentAdapter,
  promptFile?: string,
): Promise<AgentRunResult> {
  let outputFile: string | undefined;
  if (options.artifactDirectory) {
    await mkdir(options.artifactDirectory, { recursive: true });
    outputFile = path.join(options.artifactDirectory, "last-message.json");
    if (options.outputSchema && options.adapterName === "codex") {
      await writeFile(
        `${outputFile}.schema.json`,
        `${JSON.stringify(options.outputSchema, null, 2)}\n`,
      );
    }
  }
  const request = {
    cwd: options.cwd,
    prompt: options.prompt,
    ...(promptFile ? { promptFile } : {}),
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
  const invocation = adapter.buildInvocation(options.profile, request);
  assertInvocationContract(adapter, options.profile, request, invocation);
  const activityParser = adapter.createActivityParser?.();
  const stdoutLog = options.artifactDirectory
    ? createWriteStream(path.join(options.artifactDirectory, "stdout.log"), { flags: "w" })
    : undefined;
  const stderrLog = options.artifactDirectory
    ? createWriteStream(path.join(options.artifactDirectory, "stderr.log"), { flags: "w" })
    : undefined;
  const logWrites = [
    ...(stdoutLog ? [finished(stdoutLog)] : []),
    ...(stderrLog ? [finished(stderrLog)] : []),
  ];
  let process;
  try {
    process = await runProcess({
      ...invocation,
      liveChild: beginLiveChild(resolveAgentTeamStateRoot(invocation.cwd), {
        command: invocation.command,
        cwd: invocation.cwd,
        ...(options.runId ? { runId: options.runId } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
      onStdout: (chunk) => {
        stdoutLog?.write(chunk);
        for (const activity of activityParser?.push(chunk) ?? []) {
          options.onActivity?.(activity);
        }
        options.onStdout?.(chunk);
      },
      onStderr: (chunk) => {
        stderrLog?.write(chunk);
        options.onStderr?.(chunk);
      },
    });
  } finally {
    try {
      for (const activity of activityParser?.finish() ?? []) {
        options.onActivity?.(activity);
      }
    } finally {
      stdoutLog?.end();
      stderrLog?.end();
      await Promise.all(logWrites);
    }
  }
  let result: AgentRunResult;
  try {
    result = await adapter.parseResult(invocation, process);
  } catch (error) {
    const message = `${options.adapterName} output could not be parsed: ${errorMessage(error)}`;
    throw new AgentInvocationError(
      message,
      { text: process.stdout, process },
      {
        cause: error,
        classification: classifyProviderFailure({
          message,
          stdout: process.stdout,
          stderr: process.stderr,
          exitCode: process.exitCode,
          timedOut: process.timedOut,
          signal: process.signal,
          cause: error,
        }),
      },
    );
  }
  if (process.exitCode !== 0) {
    const message = `${options.adapterName} exited with ${process.exitCode}: ${process.stderr.trim() || result.text}`;
    throw new AgentInvocationError(message, result, {
      classification: classifyProviderFailure({
        message,
        stdout: result.process.stdout,
        stderr: result.process.stderr,
        exitCode: result.process.exitCode,
        timedOut: result.process.timedOut,
        signal: result.process.signal,
      }),
    });
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
