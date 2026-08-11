import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export interface ControlLease {
  release(): Promise<void>;
}

export async function acquireControlLease(stateRoot: string): Promise<ControlLease> {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, "control.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidatePath = path.join(
      stateRoot,
      `.control.lock.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(candidatePath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(candidatePath, lockPath);
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
      if (current && processIsAlive(current.pid)) {
        throw new Error(`Another control service is already running with PID ${current.pid}`);
      }
      throw new Error(
        `A stale control lease exists for PID ${current.pid}; verify no service is running, then remove '${lockPath}' manually`,
      );
    } finally {
      await unlink(candidatePath).catch(ignoreMissing);
    }
  }
  throw new Error("Could not acquire the control service lease");
}

async function readLock(lockPath: string): Promise<{ pid: number; token: string } | undefined> {
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
    const parsed = JSON.parse(text) as { pid?: unknown; token?: unknown };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof parsed.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(parsed.token)
    ) {
      throw new Error("invalid owner fields");
    }
    return { pid: parsed.pid as number, token: parsed.token };
  } catch {
    throw new Error(
      `Control lease '${lockPath}' is incomplete or invalid; refusing to take ownership`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
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
