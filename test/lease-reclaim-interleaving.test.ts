import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireControlLease } from "../src/server/lease.js";
import { isCode, type LeaseFileHandle, type LeaseFileSystem } from "../src/server/lease-fs.js";
import { legacyAcquireControlLease } from "./fixtures/legacy-control-lease.js";

/**
 * An in-memory state root whose operations can be paused one at a time.
 *
 * Real filesystems cannot be asked to hold still between a reclaimer's read and
 * its unlink, and CPU load only makes that window wider or narrower by luck.
 * Pausing it here turns "sometimes two owners" into a fixed order of events.
 */
interface VirtualFile {
  content: string;
  modifiedAt: number;
}

class VirtualStateRoot {
  readonly files = new Map<string, VirtualFile>();
  private paused = false;
  private release: (() => void) | undefined;
  private readonly gate: Promise<void>;
  private resolveGate: () => void = () => undefined;
  private readonly waiters: Array<(event: { claimant: string; op: string; path: string }) => boolean> = [];

  constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.resolveGate = resolve;
    });
  }

  seed(file: string, content: string): void {
    this.files.set(file, { content, modifiedAt: Date.now() });
  }

  read(file: string): string | undefined {
    return this.files.get(file)?.content;
  }

  /** Resolve the hold once `predicate` sees an operation worth waiting for. */
  releaseWhen(predicate: (event: { claimant: string; op: string; path: string }) => boolean): void {
    this.waiters.push(predicate);
  }

  async notify(event: { claimant: string; op: string; path: string }): Promise<void> {
    for (let index = 0; index < this.waiters.length; index += 1) {
      if (this.waiters[index]!(event)) {
        this.waiters.splice(index, 1);
        this.resolveGate();
        return;
      }
    }
  }

  async hold(): Promise<void> {
    this.paused = true;
    await this.gate;
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  forClaimant(name: string): LeaseFileSystem {
    return {
      mkdir: async () => {
        await this.notify({ claimant: name, op: "mkdir", path: "" });
      },
      openExclusive: async (file) => {
        await this.notify({ claimant: name, op: "open", path: file });
        if (this.files.has(file)) {
          throw Object.assign(new Error(`EEXIST: ${file}`), { code: "EEXIST" });
        }
        const stored: VirtualFile = { content: "", modifiedAt: Date.now() };
        this.files.set(file, stored);
        return {
          write: async (text: string) => {
            stored.content = text;
          },
          sync: async () => undefined,
          close: async () => undefined,
        } satisfies LeaseFileHandle;
      },
      link: async (from, to) => {
        const source = this.files.get(from);
        if (!source) {
          throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
        }
        if (this.files.has(to)) {
          throw Object.assign(new Error(`EEXIST: ${to}`), { code: "EEXIST" });
        }
        this.files.set(to, { content: source.content, modifiedAt: Date.now() });
        await this.notify({ claimant: name, op: "link", path: to });
      },
      read: async (file) => {
        await this.notify({ claimant: name, op: "read", path: file });
        return this.files.get(file)?.content;
      },
      unlink: async (file) => {
        if (!this.files.has(file)) {
          throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
        }
        if (!this.isPaused && this.canPauseUnlink(file)) {
          this.pauseUnlinkOf = undefined;
          await this.notify({ claimant: name, op: "unlink", path: file });
          await this.hold();
        }
        this.files.delete(file);
      },
      modifiedAt: async (file) => this.files.get(file)?.modifiedAt,
    };
  }

  private pauseUnlinkOf: string | undefined;

  /** Pause the first unlink of `file` only: the one interleaving under test. */
  pauseFirstUnlinkOf(file: string, thenReleaseWhen: (event: { claimant: string; op: string; path: string }) => boolean): void {
    this.pauseUnlinkOf = file;
    this.releaseWhen(thenReleaseWhen);
  }

  private canPauseUnlink(file: string): boolean {
    return this.pauseUnlinkOf === file;
  }

  resetHold(): void {
    this.pauseUnlinkOf = undefined;
  }
}

const STATE_ROOT = "/state";
const LOCK = path.join(STATE_ROOT, "control.lock");
const MARKER = path.join(STATE_ROOT, "control.lock.reclaim");
const STALE_TOKEN = "00000000-0000-4000-8000-000000000000";
const STALE = `${JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: STALE_TOKEN })}\n`;

const noSleep = async (): Promise<void> => undefined;

/**
 * Three claimants, one stale lock, and the interleaving that used to break it:
 * the first reclaimer stops between "the dead owner is confirmed" and "unlink",
 * another claimant takes the lock in that window, and the paused reclaimer then
 * decides to delete a lock that is no longer the dead one.
 */
async function runInterleaving(
  acquire: (fs: LeaseFileSystem) => Promise<{ release: () => Promise<void> }>,
): Promise<{ fulfilled: number; replaced: number; holdings: string[] }> {
  const root = new VirtualStateRoot();
  root.seed(LOCK, STALE);
  root.pauseFirstUnlinkOf(LOCK, (event) => {
    // Anything that means "someone else now holds or may take the lock": a
    // successful link, or a rival trying to take over. The old implementation
    // reaches the first, the marker implementation the second.
    return (
      (event.op === "link" && event.path === LOCK) ||
      (event.op === "open" && event.path === MARKER)
    );
  });

  const results = await Promise.allSettled([
    acquire(root.forClaimant("a")),
    acquire(root.forClaimant("b")),
    acquire(root.forClaimant("c")),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled").length;
  // A claimant that published the lock and then found it gone: its lease is
  // empty, and it either crashes or keeps serving without a lock of its own.
  const replaced = results.filter(
    (result) =>
      result.status === "rejected" &&
      String((result.reason as Error)?.message).includes("replaced by a concurrent claimant"),
  ).length;
  return { fulfilled, replaced, holdings: root.read(LOCK) ? [root.read(LOCK)!] : [] };
}

describe("stale lock reclamation under an injected interleaving", () => {
  it("proves the old read-then-unlink can take the lock out from under a winner", async () => {
    const { fulfilled, replaced, holdings } = await runInterleaving((fs) =>
      legacyAcquireControlLease(STATE_ROOT, { fs, sleep: noSleep }),
    );

    // The paused reclaimer deletes the lock a rival had just published, so the
    // rival either loses the lease it already held (here) or both keep one.
    expect(fulfilled + replaced).toBeGreaterThan(1);
    expect(holdings).toHaveLength(1);
  });

  it("hands the lease to exactly one claimant with the take-over marker", async () => {
    const { fulfilled, replaced, holdings } = await runInterleaving((fs) =>
      acquireControlLease(STATE_ROOT, { fs, sleep: noSleep }),
    );

    expect(fulfilled).toBe(1);
    expect(replaced).toBe(0);
    expect(holdings).toHaveLength(1);
    expect(JSON.parse(holdings[0]!)).toMatchObject({ pid: process.pid, token: expect.any(String) });
  });

  it("leaves no take-over marker behind after a reclaim", async () => {
    const root = new VirtualStateRoot();
    root.seed(LOCK, STALE);
    const lease = await acquireControlLease(STATE_ROOT, { fs: root.forClaimant("a"), sleep: noSleep });
    expect(root.files.has(MARKER)).toBe(false);
    expect([...root.files.keys()].filter((file) => file.endsWith(".tmp"))).toEqual([]);
    await lease.release();
    expect(root.files.has(LOCK)).toBe(false);
  });

  it("backs off while another claimant holds the take-over marker", async () => {
    const root = new VirtualStateRoot();
    root.seed(LOCK, STALE);
    root.seed(MARKER, `${JSON.stringify({ pid: process.pid, token: STALE_TOKEN })}\n`);
    // Our own PID is alive, so the marker belongs to a live reclaimer: a claimant
    // must not touch the lock behind its back, and must not wedge either.
    await expect(
      acquireControlLease(STATE_ROOT, { fs: root.forClaimant("a"), sleep: noSleep }),
    ).rejects.toThrow("is held by PID");
    expect(root.read(LOCK)).toBe(STALE);
    expect(root.files.has(MARKER)).toBe(true);
  });
});

describe("the virtual state root", () => {
  it("reports missing files the way the real filesystem does", async () => {
    const root = new VirtualStateRoot();
    const fs = root.forClaimant("a");
    await expect(fs.read("/state/missing")).resolves.toBeUndefined();
    let code: unknown;
    try {
      await fs.unlink("/state/missing");
    } catch (error) {
      code = isCode(error, "ENOENT");
    }
    expect(code).toBe(true);
  });
});
