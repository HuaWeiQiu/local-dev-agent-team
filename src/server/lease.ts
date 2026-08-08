import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface ControlLease {
  release(): Promise<void>;
}

export async function acquireControlLease(stateRoot: string): Promise<ControlLease> {
  await mkdir(stateRoot, { recursive: true });
  const lockPath = path.join(stateRoot, "control.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8");
      } finally {
        await handle.close();
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
      if (current && processIsAlive(current.pid)) {
        throw new Error(`Another control service is already running with PID ${current.pid}`);
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
        await unlink(stalePath).catch(ignoreMissing);
      } catch (renameError) {
        if (!isCode(renameError, "ENOENT")) {
          throw renameError;
        }
      }
    }
  }
  throw new Error("Could not acquire the control service lease");
}

async function readLock(lockPath: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    return typeof parsed.pid === "number" && typeof parsed.token === "string"
      ? { pid: parsed.pid, token: parsed.token }
      : undefined;
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return undefined;
    }
    return undefined;
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
