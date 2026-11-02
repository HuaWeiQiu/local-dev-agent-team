import { randomUUID } from "node:crypto";
import path from "node:path";
import { processIsRunning, processStartToken } from "../process/alive.js";
import {
  isCode,
  nodeLeaseFileSystem,
  type LeaseFileHandle,
  type LeaseFileSystem,
} from "./lease-fs.js";

export interface ControlLease {
  release(): Promise<void>;
}

export interface ControlLeaseOptions {
  /** Injected only by tests: they drive one acquisition one await at a time. */
  fs?: LeaseFileSystem;
  sleep?: (ms: number) => Promise<void>;
}

interface LockOwner {
  pid: number;
  token: string;
  started?: string;
}

/** Name of the lock file inside the state root. */
const LOCK_FILE = "control.lock";

/** Take-over marker that serializes stale-lock reclamation. */
const RECLAIM_MARKER = "control.lock.reclaim";

/** A marker this old whose owner is gone is the remnant of a crashed reclaim. */
const ABANDONED_MARKER_MS = 10_000;

/** Acquisition attempts before the lease is reported as unavailable. */
const LEASE_ATTEMPTS = 3;

/** Tokens are UUIDs; anything else is not a token this code ever wrote. */
const OWNER_TOKEN_PATTERN = /^[a-f0-9-]{36}$/;

interface LeasePaths {
  stateRoot: string;
  lockPath: string;
  markerPath: string;
}

export async function acquireControlLease(
  stateRoot: string,
  options: ControlLeaseOptions = {},
): Promise<ControlLease> {
  const fs = options.fs ?? nodeLeaseFileSystem;
  const sleep = options.sleep ?? defaultSleep;
  await fs.mkdir(stateRoot);
  const paths: LeasePaths = {
    stateRoot,
    lockPath: path.join(stateRoot, LOCK_FILE),
    markerPath: path.join(stateRoot, RECLAIM_MARKER),
  };
  const token = randomUUID();
  const started = await processStartToken(process.pid);
  for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt += 1) {
    if (await claimOnce(fs, sleep, paths, token, started, attempt)) {
      return controlLease(fs, paths.lockPath, token);
    }
  }
  throw await leaseUnavailable(fs, paths);
}

/**
 * One acquisition attempt: publish a complete candidate atomically, then keep
 * it only if the published lock is still the record this attempt wrote.
 * `true` means the lease is held; `false` means a stale lock was reclaimed (or
 * another process is reclaiming it) and the caller should try again.
 */
async function claimOnce(
  fs: LeaseFileSystem,
  sleep: (ms: number) => Promise<void>,
  paths: LeasePaths,
  token: string,
  started: string | undefined,
  attempt: number,
): Promise<boolean> {
  const candidatePath = candidateLockPath(paths.stateRoot);
  const handle = await fs.openExclusive(candidatePath);
  try {
    await writeOwnerRecord(handle, ownerRecord(token, started));
    await fs.link(candidatePath, paths.lockPath);
    // link 成功后再确认一次锁内容：并发回收者可能在 link 前后删掉新锁。
    // 发现不一致时拒绝启动，而不是带着别人的锁（或没有锁）继续跑。
    await assertLockOwner(fs, paths.lockPath, token);
    return true;
  } catch (error) {
    if (!isCode(error, "EEXIST")) {
      throw error;
    }
    await reclaimStaleLock(fs, sleep, paths, attempt);
    return false;
  } finally {
    await fs.unlink(candidatePath).catch(ignoreMissing);
  }
}

function candidateLockPath(stateRoot: string): string {
  return path.join(stateRoot, `.control.lock.${process.pid}.${randomUUID()}.tmp`);
}

/** The exact bytes a fresh lock file carries, shared by every claimant. */
function ownerRecord(token: string, started: string | undefined): string {
  return `${JSON.stringify({ pid: process.pid, token, ...(started ? { started } : {}) })}\n`;
}

async function writeOwnerRecord(handle: LeaseFileHandle, record: string): Promise<void> {
  try {
    await handle.write(record);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertLockOwner(
  fs: LeaseFileSystem,
  lockPath: string,
  token: string,
): Promise<void> {
  const owned = await readLock(fs, lockPath);
  if (owned?.token !== token) {
    throw new Error("Control lease was replaced by a concurrent claimant during acquisition");
  }
}

function controlLease(fs: LeaseFileSystem, lockPath: string, token: string): ControlLease {
  return {
    release: async () => {
      const current = await readLock(fs, lockPath);
      if (current?.token === token) {
        await fs.unlink(lockPath).catch(ignoreMissing);
      }
    },
  };
}

/**
 * Judge the lock that made the claim fail: a live owner is a real conflict,
 * a dead or recycled owner is a remnant that this attempt may discard.
 *
 * The discard happens while this claimant holds the take-over marker. That is
 * what makes the read-then-unlink below safe: `link` is create-only and the
 * lock name is still occupied by the dead owner's file, so no claimant can
 * publish a fresh lock between the read and the unlink. The name can only be
 * freed by a marker holder, and `open` with `O_EXCL` admits exactly one.
 */
async function reclaimStaleLock(
  fs: LeaseFileSystem,
  sleep: (ms: number) => Promise<void>,
  paths: LeasePaths,
  attempt: number,
): Promise<void> {
  const current = await readLock(fs, paths.lockPath);
  if (!current) {
    return;
  }
  if (await ownerIsAlive(current)) {
    throw new Error(`Another control service is already running with PID ${current.pid}`);
  }
  const marker = await takeOverMarker(fs, paths.markerPath);
  if (!marker) {
    await sleep(reclaimBackoffMs(attempt));
    return;
  }
  try {
    const confirmed = await readLock(fs, paths.lockPath);
    if (confirmed?.token === current.token) {
      await fs.unlink(paths.lockPath).catch(ignoreMissing);
    }
  } finally {
    await marker.close().catch(ignoreMissing);
    await fs.unlink(paths.markerPath).catch(ignoreMissing);
  }
  // 随机短退避，错开同时发现死锁的其他回收者，收窄重链窗口。
  await sleep(reclaimBackoffMs(attempt));
}

/**
 * Claim the right to reclaim. `O_CREAT|O_EXCL` is atomic on the local
 * filesystems this control service runs on (APFS, ext4, overlayfs), so exactly
 * one claimant wins the marker; everyone else backs off and retries.
 *
 * A marker left behind by a crashed reclaim is not a permanent wedge: when its
 * owner is gone and it outlived the reclaim window, the next claimant discards
 * it. That removal is by name and therefore not atomic, but the only thing it
 * can race with is another claimant discarding the same dead marker — and both
 * then meet at `open` again, where exactly one still wins.
 */
async function takeOverMarker(
  fs: LeaseFileSystem,
  markerPath: string,
): Promise<LeaseFileHandle | undefined> {
  try {
    const handle = await fs.openExclusive(markerPath);
    const started = await processStartToken(process.pid);
    await writeOwnerRecord(handle, ownerRecord(randomUUID(), started));
    return handle;
  } catch (error) {
    if (!isCode(error, "EEXIST")) {
      throw error;
    }
    await discardAbandonedMarker(fs, markerPath);
    return undefined;
  }
}

async function discardAbandonedMarker(fs: LeaseFileSystem, markerPath: string): Promise<void> {
  const marker = await readLock(fs, markerPath);
  if (!marker || (await ownerIsAlive(marker))) {
    return;
  }
  const modifiedAt = await fs.modifiedAt(markerPath);
  if (modifiedAt === undefined || Date.now() - modifiedAt < ABANDONED_MARKER_MS) {
    return;
  }
  await fs.unlink(markerPath).catch(ignoreMissing);
}

async function leaseUnavailable(fs: LeaseFileSystem, paths: LeasePaths): Promise<Error> {
  const marker = await readLock(fs, paths.markerPath).catch(() => undefined);
  if (marker) {
    return new Error(
      `Could not acquire the control service lease: '${paths.markerPath}' is held by PID ${marker.pid}`,
    );
  }
  return new Error("Could not acquire the control service lease");
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The recorded owner, or `undefined` when there is no lock file at all. */
async function readLock(fs: LeaseFileSystem, lockPath: string): Promise<LockOwner | undefined> {
  const text = await fs.read(lockPath);
  if (text === undefined) {
    return undefined;
  }
  return parseLockOwner(text, lockPath);
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

function ignoreMissing(error: unknown): void {
  if (!isCode(error, "ENOENT")) {
    throw error;
  }
}
