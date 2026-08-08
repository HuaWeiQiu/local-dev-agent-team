import { spawn } from "node:child_process";

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  request.signal?.throwIfAborted();
  const startedAt = Date.now();
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let callbackError: unknown;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const captured = captureOutput(chunk, stdoutBytes, request.maxOutputBytes);
      stdout += captured.text;
      stdoutBytes += captured.bytes;
      stdoutTruncated ||= captured.truncated;
      try {
        if (captured.text) request.onStdout?.(captured.text);
      } catch (error) {
        callbackError = error;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      const captured = captureOutput(chunk, stderrBytes, request.maxOutputBytes);
      stderr += captured.text;
      stderrBytes += captured.bytes;
      stderrTruncated ||= captured.truncated;
      try {
        if (captured.text) request.onStderr?.(captured.text);
      } catch (error) {
        callbackError = error;
      }
    });

    let escalationTimer: NodeJS.Timeout | undefined;
    let terminating = false;
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process may have exited between the status check and signal.
        }
      }
      child.kill(signal);
    };
    const abort = (): void => {
      if (terminating) {
        return;
      }
      terminating = true;
      terminate("SIGTERM");
      escalationTimer = setTimeout(() => terminate("SIGKILL"), 2_000);
      escalationTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, request.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (escalationTimer) {
        clearTimeout(escalationTimer);
      }
      request.signal?.removeEventListener("abort", abort);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (escalationTimer) {
        clearTimeout(escalationTimer);
      }
      request.signal?.removeEventListener("abort", abort);
      if (callbackError) {
        reject(callbackError);
        return;
      }
      resolve({
        command: request.command,
        args: [...request.args],
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        signal,
        stdoutBytes,
        stderrBytes,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    if (request.stdin !== undefined) {
      child.stdin.end(request.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function captureOutput(
  chunk: string,
  capturedBytes: number,
  maxOutputBytes?: number,
): { text: string; bytes: number; truncated: boolean } {
  if (maxOutputBytes === undefined) {
    return { text: chunk, bytes: Buffer.byteLength(chunk), truncated: false };
  }
  const remaining = Math.max(0, maxOutputBytes - capturedBytes);
  const chunkBytes = Buffer.byteLength(chunk);
  if (chunkBytes <= remaining) {
    return { text: chunk, bytes: chunkBytes, truncated: false };
  }
  const text = utf8Prefix(chunk, remaining);
  return { text, bytes: Buffer.byteLength(text), truncated: true };
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}
