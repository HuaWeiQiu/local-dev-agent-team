import { spawn } from "node:child_process";
import { envSecretValues, redactEnvSecrets, sanitizedChildEnv } from "./env.js";
import type { LiveChildHandle } from "./live-children.js";

export interface StreamProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
  liveChild?: LiveChildHandle;
  maxStderrBytes?: number;
}

export interface StreamProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/**
 * A long-lived child process spoken to over line-delimited stdio. It never
 * goes through a shell; callers pass an argument vector.
 */
export interface StreamProcess {
  readonly pid: number | undefined;
  write(line: string): boolean;
  closeStdin(): void;
  terminate(): void;
  readonly exited: Promise<StreamProcessExit>;
  stderrTail(): string;
}

const DEFAULT_STDERR_BYTES = 64 * 1024;

export function spawnStreamProcess(request: StreamProcessRequest): StreamProcess {
  const secrets = envSecretValues();
  const redact = (chunk: string): string =>
    secrets.length > 0 ? redactEnvSecrets(chunk, secrets) : chunk;
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env ?? sanitizedChildEnv(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (child.pid) {
    void request.liveChild?.attach(child.pid).catch(() => undefined);
  }

  const limit = request.maxStderrBytes ?? DEFAULT_STDERR_BYTES;
  let stderr = "";
  let buffered = "";
  let spawnError: Error | undefined;
  let finished = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (raw: string) => {
    buffered += redact(raw);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) request.onLine(line);
      newline = buffered.indexOf("\n");
    }
  });
  child.stderr.on("data", (raw: string) => {
    const chunk = redact(raw);
    stderr = (stderr + chunk).slice(-limit);
    request.onStderr?.(chunk);
  });
  child.stdin.on("error", () => undefined);

  const exited = new Promise<StreamProcessExit>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      finished = true;
      if (buffered.trim().length > 0) request.onLine(buffered.trim());
      buffered = "";
      void request.liveChild?.release().catch(() => undefined);
      resolve({ exitCode, signal, ...(spawnError ? { error: spawnError } : {}) });
    });
  });

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Already exited.
      }
    }
    child.kill(signal);
  };

  return {
    pid: child.pid,
    write(line) {
      if (finished || child.stdin.destroyed || !child.stdin.writable) return false;
      return child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    closeStdin() {
      if (!child.stdin.destroyed) child.stdin.end();
    },
    terminate() {
      if (finished) return;
      signalGroup("SIGTERM");
      const escalation = setTimeout(() => {
        if (!finished) signalGroup("SIGKILL");
      }, 2_000);
      escalation.unref();
    },
    exited,
    stderrTail: () => stderr,
  };
}
