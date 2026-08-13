import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessLiveness = "dead" | "alive" | "zombie";

/**
 * PID liveness that treats a zombie as dead.
 * `kill(pid, 0)` succeeds for zombies, so lease reclaim and orphan
 * reaping must inspect `ps` state instead of trusting the signal.
 */
export async function processLiveness(pid: number): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return "dead";
  }
  if (process.platform === "win32") {
    return signalAlive(pid) ? "alive" : "dead";
  }
  const stat = await processStat(pid);
  if (stat === undefined) {
    return signalAlive(pid) ? "alive" : "dead";
  }
  if (stat.includes("Z")) {
    return "zombie";
  }
  return signalAlive(pid) ? "alive" : "dead";
}

export async function processIsRunning(pid: number): Promise<boolean> {
  return (await processLiveness(pid)) === "alive";
}

export async function processStartToken(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const started = stdout.trim();
    return started.length > 0 ? started : undefined;
  } catch {
    return undefined;
  }
}

export function signalAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function processStat(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]);
    const stat = stdout.trim();
    return stat.length > 0 ? stat : undefined;
  } catch {
    return undefined;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
