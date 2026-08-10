import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { finished } from "node:stream/promises";
import path from "node:path";
import type { AgentProfile } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import type { AgentAdapter, AgentRunResult } from "./types.js";
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
  maxOutputBytes?: number;
}

export class AgentInvocationError extends Error {
  override readonly name = "AgentInvocationError";

  constructor(
    message: string,
    readonly result: AgentRunResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
      onStdout: (chunk) => {
        stdoutLog?.write(chunk);
        options.onStdout?.(chunk);
      },
      onStderr: (chunk) => {
        stderrLog?.write(chunk);
        options.onStderr?.(chunk);
      },
    });
  } finally {
    stdoutLog?.end();
    stderrLog?.end();
    await Promise.all(logWrites);
  }
  let result: AgentRunResult;
  try {
    result = await adapter.parseResult(invocation, process);
  } catch (error) {
    throw new AgentInvocationError(
      `${options.adapterName} output could not be parsed: ${errorMessage(error)}`,
      { text: process.stdout, process },
      { cause: error },
    );
  }
  if (process.exitCode !== 0) {
    throw new AgentInvocationError(
      `${options.adapterName} exited with ${process.exitCode}: ${process.stderr.trim() || result.text}`,
      result,
    );
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
