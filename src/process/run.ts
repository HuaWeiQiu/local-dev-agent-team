import { spawn } from "node:child_process";

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
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
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const startedAt = Date.now();
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, request.timeoutMs);

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: request.command,
        args: [...request.args],
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        signal,
      });
    });

    if (request.stdin !== undefined) {
      child.stdin.end(request.stdin);
    } else {
      child.stdin.end();
    }
  });
}
