import { randomUUID } from "node:crypto";
import { type FileHandle, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { processIsRunning, processStartToken } from "../process/alive.js";

export interface ControlLease {
  release(): Promise<void>;
}

interface LockOwner {
  pid: number;
  token: string;
  started?: string;
}

/** Name of the lock file inside the state root. */
const LOCK_FILE = "control.lock";

/** Acquisition attempts before the lease is reported as unavailable. */
const LEASE_ATTEMPTS = 3;

/** Tokens are UUIDs; anything else is not a token this code ever wrote. */
const OWNER_TOKEN_PATTERN = /^[a-f0-9-]{36}$/;

export async function acquireControlLease(stateRoot: string): Promise<ControlLease> {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, LOCK_FILE);
  const token = randomUUID();
  const started = await processStartToken(process.pid);
  for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt += 1) {
    if (await claimOnce(stateRoot, lockPath, token, started, attempt)) {
      return controlLease(lockPath, token);
    }
  }
  throw new Error("Could not acquire the control service lease");
}

/**
 * One acquisition attempt: publish a complete candidate atomically, then keep
 * it only if the published lock is still the record this attempt wrote.
 * `true` means the lease is held; `false` means a stale lock was reclaimed and
 * the caller should try again.
 */
async function claimOnce(
  stateRoot: string,
  lockPath: string,
  token: string,
  started: string | undefined,
  attempt: number,
): Promise<boolean> {
  const candidatePath = candidateLockPath(stateRoot);
  const handle = await open(candidatePath, "wx", 0o600);
  try {
    await writeOwnerRecord(handle, ownerRecord(token, started));
    await link(candidatePath, lockPath);
    // link 成功后再确认一次锁内容：并发回收者可能在 link 前后删掉新锁。
    // 发现不一致时拒绝启动，而不是带着别人的锁（或没有锁）继续跑。
    await assertLockOwner(lockPath, token);
    return true;
  } catch (error) {
    if (!isCode(error, "EEXIST")) {
      throw error;
    }
    await reclaimStaleLock(lockPath, attempt);
    return false;
  } finally {
    await unlink(candidatePath).catch(ignoreMissing);
  }
}

function candidateLockPath(stateRoot: string): string {
  return path.join(stateRoot, `.control.lock.${process.pid}.${randomUUID()}.tmp`);
}

/** The exact bytes a fresh lock file carries, shared by every claimant. */
function ownerRecord(token: string, started: string | undefined): string {
  return `${JSON.stringify({ pid: process.pid, token, ...(started ? { started } : {}) })}\n`;
}

async function writeOwnerRecord(handle: FileHandle, record: string): Promise<void> {
  try {
    await handle.writeFile(record, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertLockOwner(lockPath: string, token: string): Promise<void> {
  const owned = await readLock(lockPath);
  if (owned?.token !== token) {
    throw new Error("Control lease was replaced by a concurrent claimant during acquisition");
  }
}

function controlLease(lockPath: string, token: string): ControlLease {
  return {
    release: async () => {
      const current = await readLock(lockPath);
      if (current?.token === token) {
        await unlink(lockPath).catch(ignoreMissing);
      }
    },
  };
}

/**
 * Judge the lock that made the claim fail: a live owner is a real conflict,
 * a dead or recycled owner is a remnant that this attempt may discard.
 */
async function reclaimStaleLock(lockPath: string, attempt: number): Promise<void> {
  const current = await readLock(lockPath);
  if (!current) {
    return;
  }
  if (await ownerIsAlive(current)) {
    throw new Error(`Another control service is already running with PID ${current.pid}`);
  }
  // PID 已死（或已被无关进程复用）：lease 是残留的，可以安全回收。
  // unlink 前再校验一次 token，避免删掉并发 claim 者刚写入的新锁。
  await discardIfStillOwner(lockPath, current.token);
  // 随机短退避，错开同时发现死锁的其他回收者，收窄重链窗口。
  await sleep(reclaimBackoffMs(attempt));
}

async function discardIfStillOwner(lockPath: string, token: string): Promise<void> {
  const confirm = await readLock(lockPath);
  if (confirm?.token === token) {
    await unlink(lockPath).catch(ignoreMissing);
  }
}

async function ownerIsAlive(owner: LockOwner): Promise<boolean> {
  if (!(await processIsRunning(owner.pid))) {
    return false;
  }
  // 旧格式锁没有启动时间，或 ps 不可用：降级为仅按 PID 存活性判定。
  if (owner.started === undefined) {
    return true;
  }
  const started = await processStartToken(owner.pid);
  if (started === undefined) {
    return true;
  }
  // PID 存活但启动时间与记录不符：PID 已被无关进程复用，锁是残留的。
  return started === owner.started;
}

function reclaimBackoffMs(attempt: number): number {
  return 10 + attempt * 15 + Math.floor(Math.random() * 20);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The recorded owner, or `undefined` when there is no lock file at all. */
async function readLock(lockPath: string): Promise<LockOwner | undefined> {
  const text = await readLockText(lockPath);
  if (text === undefined) {
    return undefined;
  }
  return parseLockOwner(text, lockPath);
}

async function readLockText(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function parseLockOwner(text: string, lockPath: string): LockOwner {
  const parsed = parseLockJson(text, lockPath);
  if (!isOwnerRecord(parsed)) {
    throw incompleteLock(lockPath);
  }
  return ownerFromRecord(parsed);
}

function parseLockJson(text: string, lockPath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw incompleteLock(lockPath);
  }
}

function incompleteLock(lockPath: string): Error {
  return new Error(
    `Control lease '${lockPath}' is incomplete or invalid; refusing to take ownership`,
  );
}

/**
 * A lock is only trustworthy when it carries nothing but the owner fields this
 * code writes. Anything else fails closed instead of being reinterpreted.
 */
function isOwnerRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    hasOwnerFields(value as Record<string, unknown>)
  );
}

function hasOwnerFields(record: Record<string, unknown>): boolean {
  return (
    [2, 3].includes(Object.keys(record).length) &&
    isOwnerPid(record.pid) &&
    isOwnerToken(record.token) &&
    hasAcceptableStarted(record)
  );
}

function isOwnerPid(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOwnerToken(value: unknown): value is string {
  return typeof value === "string" && OWNER_TOKEN_PATTERN.test(value);
}

function hasAcceptableStarted(record: Record<string, unknown>): boolean {
  return "started" in record ? isOwnerStarted(record.started) : true;
}

function isOwnerStarted(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function ownerFromRecord(record: Record<string, unknown>): LockOwner {
  return {
    pid: record.pid as number,
    token: record.token as string,
    ...(typeof record.started === "string" ? { started: record.started } : {}),
  };
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function ignoreMissing(error: unknown): void {
  if (!isCode(error, "ENOENT")) {
    throw error;
  }
}
