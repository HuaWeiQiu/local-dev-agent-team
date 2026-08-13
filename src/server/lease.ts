import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
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

export async function acquireControlLease(stateRoot: string): Promise<ControlLease> {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, "control.lock");
  const token = randomUUID();
  const started = await processStartToken(process.pid);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidatePath = path.join(
      stateRoot,
      `.control.lock.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(candidatePath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, token, ...(started ? { started } : {}) })}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(candidatePath, lockPath);
      // link 成功后再确认一次锁内容：并发回收者可能在 link 前后删掉新锁。
      // 发现不一致时拒绝启动，而不是带着别人的锁（或没有锁）继续跑。
      const owned = await readLock(lockPath);
      if (owned?.token !== token) {
        throw new Error("Control lease was replaced by a concurrent claimant during acquisition");
      }
      return {
        release: async () => {
          const current = await readLock(lockPath);
          if (current?.token === token) {
            await unlink(lockPath).catch(ignoreMissing);
          }
        },
      };
    } catch (error) {
      if (!isCode(error, "EEXIST")) {
        throw error;
      }
      const current = await readLock(lockPath);
      if (!current) continue;
      if (await ownerIsAlive(current)) {
        throw new Error(`Another control service is already running with PID ${current.pid}`);
      }
      // PID 已死（或已被无关进程复用）：lease 是残留的，可以安全回收。
      // unlink 前再校验一次 token，避免删掉并发 claim 者刚写入的新锁。
      const confirm = await readLock(lockPath);
      if (confirm && confirm.token === current.token) {
        await unlink(lockPath).catch(ignoreMissing);
      }
      // 随机短退避，错开同时发现死锁的其他回收者，收窄重链窗口。
      await sleep(reclaimBackoffMs(attempt));
      continue;
    } finally {
      await unlink(candidatePath).catch(ignoreMissing);
    }
  }
  throw new Error("Could not acquire the control service lease");
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

async function readLock(lockPath: string): Promise<LockOwner | undefined> {
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; token?: unknown; started?: unknown };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      ![2, 3].includes(Object.keys(parsed).length) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof parsed.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(parsed.token) ||
      ("started" in parsed &&
        (typeof parsed.started !== "string" ||
          parsed.started.length === 0 ||
          parsed.started.length > 64))
    ) {
      throw new Error("invalid owner fields");
    }
    return {
      pid: parsed.pid as number,
      token: parsed.token,
      ...(typeof parsed.started === "string" ? { started: parsed.started } : {}),
    };
  } catch {
    throw new Error(
      `Control lease '${lockPath}' is incomplete or invalid; refusing to take ownership`,
    );
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function ignoreMissing(error: unknown): void {
  if (!isCode(error, "ENOENT")) {
    throw error;
  }
}
