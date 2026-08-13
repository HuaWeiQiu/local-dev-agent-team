import { execFile } from "node:child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { processIsRunning, processLiveness, processStartToken } from "./alive.js";

const execFileAsync = promisify(execFile);
const ledgerDirectoryName = "live-children";
const killGraceMs = 2_000;
const agentCliName = /^(grok|codex|claude|claude-code|kimi)([-.][\w.]+)?(\.exe)?$/i;

export interface LiveChildRecord {
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  runId?: string;
  startToken?: string;
}

export interface LiveChildHandle {
  attach(pid: number): Promise<void>;
  release(): Promise<void>;
}

export interface ReapOrphansResult {
  killed: number[];
}

export function beginLiveChild(
  stateRoot: string,
  meta: { command: string; cwd: string; runId?: string },
): LiveChildHandle {
  let recordedPid: number | undefined;
  return {
    async attach(pid: number): Promise<void> {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        return;
      }
      recordedPid = pid;
      const record: LiveChildRecord = {
        pid,
        command: meta.command,
        cwd: meta.cwd,
        startedAt: new Date().toISOString(),
        ...(meta.runId ? { runId: meta.runId } : {}),
      };
      // Persist before the first await so a crash cannot lose the pid.
      writeRecordSync(stateRoot, record);
      const startToken = await processStartToken(pid);
      if (startToken && recordedPid === pid) {
        writeRecordSync(stateRoot, { ...record, startToken });
      }
    },
    async release(): Promise<void> {
      if (recordedPid === undefined) {
        return;
      }
      await removeRecord(stateRoot, recordedPid);
      recordedPid = undefined;
    },
  };
}

/**
 * Kill leftover agent CLIs after a control-service crash.
 * Safe at startup: this supervisor has the lease and has not spawned workers yet.
 */
export async function reapOrphanAgentProcesses(options: {
  stateRoot: string;
  worktreesRoot: string;
}): Promise<ReapOrphansResult> {
  const recorded = await listRecords(options.stateRoot);
  const scanned = await scanWorktreeAgentPids(options.worktreesRoot);
  const seen = new Set<number>();
  const killed: number[] = [];
  for (const target of [...recorded, ...scanned]) {
    if (seen.has(target.pid) || !isSafeToSignal(target.pid)) {
      if (target.forget) {
        await removeRecord(options.stateRoot, target.pid);
      }
      continue;
    }
    seen.add(target.pid);
    if (target.forget) {
      // Ledger files live inside the project directory, so an untrusted
      // repository can plant records. The startToken (process start time)
      // matching the live process is the only proof that this control
      // service spawned it; command and cwd checks are extra sanity. A
      // record that fails any check is discarded, never killed. The ps
      // scan path (forget: false) already proves its own identity through
      // the live command line, so it keeps its existing behavior.
      const trustworthy =
        typeof target.startToken === "string" &&
        isAgentCliCommand(target.command) &&
        cwdWithinManagedRoots(target.cwd, options.stateRoot, options.worktreesRoot) &&
        (await processStartToken(target.pid)) === target.startToken;
      if (!trustworthy) {
        await removeRecord(options.stateRoot, target.pid);
        continue;
      }
    }
    const liveness = await processLiveness(target.pid);
    if (liveness === "alive") {
      await escalateKill(target.pid);
      killed.push(target.pid);
    }
    if (target.forget) {
      await removeRecord(options.stateRoot, target.pid);
    }
  }
  return { killed };
}

export async function escalateKill(pid: number, graceMs = killGraceMs): Promise<void> {
  signalTree(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await processIsRunning(pid))) {
      return;
    }
    await sleep(50);
  }
  signalTree(pid, "SIGKILL");
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
      // Not a process-group leader, or already gone.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function isSafeToSignal(pid: number): boolean {
  return pid > 1 && pid !== process.pid && pid !== process.ppid;
}

/**
 * Ledger records may be planted by an untrusted repository, so their cwd is
 * only accepted as a sanity check when it stays inside the project root or
 * the managed worktrees root. The startToken match remains the real gate.
 */
function cwdWithinManagedRoots(cwd: string, stateRoot: string, worktreesRoot: string): boolean {
  const resolved = path.resolve(cwd);
  const projectRoot = path.dirname(path.resolve(stateRoot));
  const within = (root: string): boolean =>
    resolved === root || resolved.startsWith(`${root}${path.sep}`);
  return within(projectRoot) || within(path.resolve(worktreesRoot));
}

function writeRecordSync(stateRoot: string, record: LiveChildRecord): void {
  const directory = ledgerDirectory(stateRoot);
  mkdirSync(directory, { recursive: true });
  const target = recordPath(stateRoot, record.pid);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

async function removeRecord(stateRoot: string, pid: number): Promise<void> {
  try {
    unlinkSync(recordPath(stateRoot, pid));
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      await rm(recordPath(stateRoot, pid), { force: true });
    }
  }
}

async function listRecords(stateRoot: string): Promise<Array<LiveChildRecord & { forget: true }>> {
  const directory = ledgerDirectory(stateRoot);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const records: Array<LiveChildRecord & { forget: true }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, name), "utf8")) as Partial<LiveChildRecord>;
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) {
        continue;
      }
      records.push({
        pid: parsed.pid as number,
        command: typeof parsed.command === "string" ? parsed.command : "unknown",
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
        ...(typeof parsed.startToken === "string" ? { startToken: parsed.startToken } : {}),
        forget: true,
      });
    } catch {
      // Incomplete file from a crash during write; skip.
    }
  }
  return records;
}

async function scanWorktreeAgentPids(
  worktreesRoot: string,
): Promise<Array<{ pid: number; startToken?: string; forget?: false }>> {
  const prefix = path.resolve(worktreesRoot);
  try {
    const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const matches: Array<{ pid: number }> = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.search(/\s/);
      if (separator <= 0) {
        continue;
      }
      const pid = Number(trimmed.slice(0, separator));
      const command = trimmed.slice(separator).trim();
      if (
        !Number.isSafeInteger(pid) ||
        !commandTouchesWorktree(command, prefix) ||
        !isAgentCliCommand(command)
      ) {
        continue;
      }
      matches.push({ pid });
    }
    return matches;
  } catch {
    return [];
  }
}

function commandTouchesWorktree(command: string, worktreesRoot: string): boolean {
  if (command.includes(worktreesRoot)) {
    return true;
  }
  const cwdFlag = command.match(/(?:--cwd|-C)\s+(\S+)/);
  const flagged = cwdFlag?.[1]?.replace(/^['"]|['"]$/g, "");
  return Boolean(flagged && path.resolve(flagged).startsWith(`${worktreesRoot}${path.sep}`));
}

export function isAgentCliCommand(command: string): boolean {
  for (const token of commandTokens(command)) {
    if (agentCliName.test(path.basename(token))) {
      return true;
    }
  }
  return false;
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  const matcher = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter(Boolean);
}

function ledgerDirectory(stateRoot: string): string {
  return path.join(stateRoot, ledgerDirectoryName);
}

function recordPath(stateRoot: string, pid: number): string {
  return path.join(ledgerDirectory(stateRoot), `${pid}.json`);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
