import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import path from "node:path";
import type { AgentProfile } from "../config/schema.js";
import { beginLiveChild } from "../process/live-children.js";
import { runProcess, type ProcessResult } from "../process/run.js";
import { resolveAgentTeamStateRoot } from "../process/state-root.js";
import {
  classifyProviderFailure,
  type ProviderFailureClassification,
} from "../providers/failure.js";
import type {
  AgentActivityParser,
  AgentActivitySnapshot,
  AgentAdapter,
  AgentInvocation,
  AgentInvocationRequest,
  AgentRunResult,
} from "./types.js";
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

/** The durable streams one invocation writes into its artifact directory. */
interface InvocationLogs {
  stdout: WriteStream | undefined;
  stderr: WriteStream | undefined;
  writes: Promise<void>[];
}

/**
 * One invocation, in the order it must happen: decide what to ask for, spawn,
 * always close the logs, then read the outcome. The steps live in the helpers
 * below so each decision is a named function instead of a nested branch.
 */
async function invokePreparedAgent(
  options: InvokeOptions,
  adapter: AgentAdapter,
  promptFile?: string,
): Promise<AgentRunResult> {
  const outputFile = await prepareArtifactDirectory(options);
  const request = invocationRequest(options, promptFile, outputFile);
  const invocation = adapter.buildInvocation(options.profile, request);
  assertInvocationContract(adapter, options.profile, request, invocation);
  const activityParser = adapter.createActivityParser?.();
  const logs = openInvocationLogs(options.artifactDirectory);
  const process = await runInvocation(options, invocation, activityParser, logs);
  return await readInvocationOutcome(options.adapterName, adapter, invocation, process);
}

/**
 * Create the artifact directory and the files the adapter reads by path.
 * Only the file that receives the last message is promised to the caller.
 */
async function prepareArtifactDirectory(options: InvokeOptions): Promise<string | undefined> {
  const directory = options.artifactDirectory;
  if (!directory) {
    return undefined;
  }
  await mkdir(directory, { recursive: true });
  const outputFile = path.join(directory, "last-message.json");
  if (needsSchemaSidecar(options.adapterName, options.outputSchema)) {
    await writeFile(
      `${outputFile}.schema.json`,
      `${JSON.stringify(options.outputSchema, null, 2)}\n`,
    );
  }
  return outputFile;
}

/** Codex is the only adapter that is handed a schema next to the output file. */
export function needsSchemaSidecar(
  adapterName: string,
  outputSchema: Record<string, unknown> | undefined,
): boolean {
  return adapterName === "codex" && outputSchema !== undefined;
}

/** What the adapter is asked for; absent fields are absent, not undefined. */
export function invocationRequest(
  options: Pick<InvokeOptions, "cwd" | "prompt" | "outputSchema">,
  promptFile: string | undefined,
  outputFile: string | undefined,
): AgentInvocationRequest {
  return {
    cwd: options.cwd,
    prompt: options.prompt,
    ...(promptFile ? { promptFile } : {}),
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
}

function openInvocationLogs(artifactDirectory: string | undefined): InvocationLogs {
  const stdout = openLogStream(artifactDirectory, "stdout.log");
  const stderr = openLogStream(artifactDirectory, "stderr.log");
  return { stdout, stderr, writes: [...pendingWrite(stdout), ...pendingWrite(stderr)] };
}

function openLogStream(
  artifactDirectory: string | undefined,
  name: string,
): WriteStream | undefined {
  return artifactDirectory
    ? createWriteStream(path.join(artifactDirectory, name), { flags: "w" })
    : undefined;
}

/** `finished` has to be registered before anything can end the stream. */
function pendingWrite(stream: WriteStream | undefined): Promise<void>[] {
  return stream ? [finished(stream)] : [];
}

/** Run the process, and close its logs however the run ends. */
async function runInvocation(
  options: InvokeOptions,
  invocation: AgentInvocation,
  activityParser: AgentActivityParser | undefined,
  logs: InvocationLogs,
): Promise<ProcessResult> {
  try {
    return await spawnInvocation(options, invocation, activityParser, logs);
  } finally {
    await closeInvocationLogs(activityParser, logs, options.onActivity);
  }
}

/** The process request: the adapter's invocation plus this run's wiring. */
function spawnInvocation(
  options: InvokeOptions,
  invocation: AgentInvocation,
  activityParser: AgentActivityParser | undefined,
  logs: InvocationLogs,
): Promise<ProcessResult> {
  return runProcess({
    ...invocation,
    liveChild: beginLiveChild(resolveAgentTeamStateRoot(invocation.cwd), {
      command: invocation.command,
      cwd: invocation.cwd,
      ...(options.runId ? { runId: options.runId } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
    onStdout: (chunk) => forwardStdout(chunk, options, activityParser, logs.stdout),
    onStderr: (chunk) => forwardStderr(chunk, options, logs.stderr),
  });
}

/** Every stdout chunk goes to the log, the activity parser, then the caller. */
function forwardStdout(
  chunk: string,
  options: InvokeOptions,
  activityParser: AgentActivityParser | undefined,
  log: WriteStream | undefined,
): void {
  log?.write(chunk);
  deliverActivity(activityParser?.push(chunk) ?? [], options.onActivity);
  options.onStdout?.(chunk);
}

function deliverActivity(
  activities: AgentActivitySnapshot[],
  onActivity: ((activity: AgentActivitySnapshot) => void) | undefined,
): void {
  for (const activity of activities) {
    onActivity?.(activity);
  }
}

function forwardStderr(chunk: string, options: InvokeOptions, log: WriteStream | undefined): void {
  log?.write(chunk);
  options.onStderr?.(chunk);
}

async function closeInvocationLogs(
  activityParser: AgentActivityParser | undefined,
  logs: InvocationLogs,
  onActivity: ((activity: AgentActivitySnapshot) => void) | undefined,
): Promise<void> {
  try {
    // The parser reports what it still holds when the process ends.
    deliverActivity(activityParser?.finish() ?? [], onActivity);
  } finally {
    await endLogs(logs);
  }
}

async function endLogs(logs: InvocationLogs): Promise<void> {
  logs.stdout?.end();
  logs.stderr?.end();
  await Promise.all(logs.writes);
}

/** Read what the adapter made of the process, then insist the process succeeded. */
async function readInvocationOutcome(
  adapterName: string,
  adapter: AgentAdapter,
  invocation: AgentInvocation,
  process: ProcessResult,
): Promise<AgentRunResult> {
  const result = await parseInvocationResult(adapterName, adapter, invocation, process);
  assertSuccessfulExit(adapterName, process, result);
  return result;
}

/** An output the adapter cannot read is reported before the exit code is judged. */
async function parseInvocationResult(
  adapterName: string,
  adapter: AgentAdapter,
  invocation: AgentInvocation,
  process: ProcessResult,
): Promise<AgentRunResult> {
  try {
    return await adapter.parseResult(invocation, process);
  } catch (error) {
    const message = unparsableOutputMessage(adapterName, error);
    throw new AgentInvocationError(
      message,
      { text: process.stdout, process },
      {
        cause: error,
        classification: classifyInvocationFailure(message, process, error),
      },
    );
  }
}

export function unparsableOutputMessage(adapterName: string, error: unknown): string {
  return `${adapterName} output could not be parsed: ${errorMessage(error)}`;
}

function assertSuccessfulExit(
  adapterName: string,
  process: ProcessResult,
  result: AgentRunResult,
): void {
  if (process.exitCode === 0) {
    return;
  }
  const message = exitFailureMessage(adapterName, process, result.text);
  throw new AgentInvocationError(message, result, {
    classification: classifyInvocationFailure(message, result.process),
  });
}

/** A failed run reports the provider's stderr, or the parsed text when silent. */
export function exitFailureMessage(
  adapterName: string,
  process: ProcessResult,
  text: string,
): string {
  return `${adapterName} exited with ${process.exitCode}: ${process.stderr.trim() || text}`;
}

/** Both failure paths describe the same process the same way. */
function classifyInvocationFailure(
  message: string,
  process: ProcessResult,
  cause?: unknown,
): ProviderFailureClassification {
  return classifyProviderFailure({
    message,
    stdout: process.stdout,
    stderr: process.stderr,
    exitCode: process.exitCode,
    timedOut: process.timedOut,
    signal: process.signal,
    ...(cause === undefined ? {} : { cause }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
