import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessLiveness = "dead" | "alive" | "zombie";

/** A pid worth asking the OS about: positive and exactly representable. */
function isUsablePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

/** `kill(pid, 0)` is the cheapest answer; EPERM still means the process exists. */
export function signalAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function signalLiveness(pid: number): ProcessLiveness {
  return signalAlive(pid) ? "alive" : "dead";
}

/** `ps` state Z means the process is waiting to be reaped: treat it as dead. */
function statLiveness(pid: number, stat: string): ProcessLiveness {
  return stat.includes("Z") ? "zombie" : signalLiveness(pid);
}

function livenessFromStat(pid: number, stat: string | undefined): ProcessLiveness {
  return stat === undefined ? signalLiveness(pid) : statLiveness(pid, stat);
}

/**
 * PID liveness that treats a zombie as dead.
 * `kill(pid, 0)` succeeds for zombies, so lease reclaim and orphan
 * reaping must inspect `ps` state instead of trusting the signal.
 */
export async function processLiveness(pid: number): Promise<ProcessLiveness> {
  if (!isUsablePid(pid)) return "dead";
  if (isWindows()) return signalLiveness(pid);
  return livenessFromStat(pid, await psField(pid, "stat"));
}

export async function processIsRunning(pid: number): Promise<boolean> {
  return (await processLiveness(pid)) === "alive";
}

export async function processStartToken(pid: number): Promise<string | undefined> {
  return await psField(pid, "lstart");
}

/** One `ps -o <column>=` read; an empty or unreadable answer is "unknown". */
async function psField(pid: number, column: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", `${column}=`, "-p", String(pid)]);
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
