import { randomUUID } from "node:crypto";
import path from "node:path";
import { processIsRunning, processStartToken } from "../../src/process/alive.js";
import { isCode, type LeaseFileHandle, type LeaseFileSystem } from "../../src/server/lease-fs.js";

/**
 * The reclamation this repository shipped before the take-over marker: a
 * reclaimer read the dead owner's record, confirmed it, and unlinked by name.
 *
 * Frozen here on purpose. A mutual-exclusion fix is only worth anything if the
 * same interleaving still breaks the implementation it replaced, so the test
 * drives both and the old one has to fail.
 */
export async function legacyAcquireControlLease(
  stateRoot: string,
  options: { fs: LeaseFileSystem; sleep: (ms: number) => Promise<void> },
): Promise<{ release: () => Promise<void> }> {
  const { fs, sleep } = options;
  await fs.mkdir(stateRoot);
  const lockPath = path.join(stateRoot, "control.lock");
  const token = randomUUID();
  const started = await processStartToken(process.pid);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await legacyClaimOnce(fs, sleep, stateRoot, lockPath, token, started, attempt)) {
      return {
        release: async () => {
          const owner = await legacyReadOwner(fs, lockPath);
          if (owner?.token === token) {
            await fs.unlink(lockPath).catch(ignoreMissing);
          }
        },
      };
    }
  }
  throw new Error("Could not acquire the control service lease");
}

async function legacyClaimOnce(
  fs: LeaseFileSystem,
  sleep: (ms: number) => Promise<void>,
  stateRoot: string,
  lockPath: string,
  token: string,
  started: string | undefined,
  attempt: number,
): Promise<boolean> {
  const candidatePath = path.join(stateRoot, `.control.lock.${process.pid}.${randomUUID()}.tmp`);
  const handle: LeaseFileHandle = await fs.openExclusive(candidatePath);
  try {
    await writeRecord(handle, record(token, started));
    await fs.link(candidatePath, lockPath);
    const owned = await legacyReadOwner(fs, lockPath);
    if (owned?.token !== token) {
      throw new Error("Control lease was replaced by a concurrent claimant during acquisition");
    }
    return true;
  } catch (error) {
    if (!isCode(error, "EEXIST")) {
      throw error;
    }
    await legacyReclaim(fs, sleep, lockPath, attempt);
    return false;
  } finally {
    await fs.unlink(candidatePath).catch(ignoreMissing);
  }
}

/** read → judge → confirm → unlink, with no exclusion between any two of them. */
async function legacyReclaim(
  fs: LeaseFileSystem,
  sleep: (ms: number) => Promise<void>,
  lockPath: string,
  attempt: number,
): Promise<void> {
  const current = await legacyReadOwner(fs, lockPath);
  if (current && (await alive(current))) {
    throw new Error(`Another control service is already running with PID ${current.pid}`);
  }
  if (current) {
    const confirm = await legacyReadOwner(fs, lockPath);
    if (confirm?.token === current.token) {
      await fs.unlink(lockPath).catch(ignoreMissing);
    }
  }
  await sleep(10 + attempt * 15);
}

function record(token: string, started: string | undefined): string {
  return `${JSON.stringify({ pid: process.pid, token, ...(started ? { started } : {}) })}\n`;
}

async function writeRecord(handle: LeaseFileHandle, text: string): Promise<void> {
  try {
    await handle.write(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function legacyReadOwner(
  fs: LeaseFileSystem,
  lockPath: string,
): Promise<{ pid: number; token: string; started?: string } | undefined> {
  const text = await fs.read(lockPath);
  if (text === undefined) {
    return undefined;
  }
  return JSON.parse(text) as { pid: number; token: string; started?: string };
}

async function alive(owner: { pid: number; started?: string }): Promise<boolean> {
  if (!(await processIsRunning(owner.pid))) {
    return false;
  }
  if (owner.started === undefined) {
    return true;
  }
  const started = await processStartToken(owner.pid);
  return started === undefined ? true : started === owner.started;
}

function ignoreMissing(error: unknown): void {
  if (!isCode(error, "ENOENT")) {
    throw error;
  }
}
