import { access, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireControlLease } from "../src/server/lease.js";

describe("project control lease", () => {
  it("publishes one complete owner atomically under concurrent acquisition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-race-"));
    const results = await Promise.allSettled([
      acquireControlLease(root),
      acquireControlLease(root),
    ]);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireControlLease>>> =>
        result.status === "fulfilled",
    );
    expect(acquired).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const owner = JSON.parse(await readFile(path.join(root, "control.lock"), "utf8")) as {
      pid: number;
      token: string;
    };
    expect(owner).toMatchObject({ pid: process.pid, token: expect.any(String) });
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    await acquired[0]!.value.release();
  });

  it.each([
    "",
    `{"pid":${process.pid}`,
    JSON.stringify({ pid: process.pid, token: "not-a-lease-token" }),
  ])("fails closed without replacing an incomplete or invalid lock", async (contents) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-invalid-"));
    const lockPath = path.join(root, "control.lock");
    await writeFile(lockPath, contents, "utf8");
    await expect(acquireControlLease(root)).rejects.toThrow("incomplete or invalid");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(contents);
  });

  it("discards a take-over marker left behind by a dead reclaimer", async () => {
    // The abandoned-marker branch used to be reached only when three claimants
    // happened to collide, so whether it ran (and therefore its coverage) depended
    // on timing. Here the marker is exactly what a crashed reclaim leaves: a dead
    // owner and an age past the reclaim window.
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-marker-"));
    const lockPath = path.join(root, "control.lock");
    const markerPath = path.join(root, "control.lock.reclaim");
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: "00000000-0000-4000-8000-000000000000" })}\n`,
      "utf8",
    );
    await writeFile(
      markerPath,
      `${JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: "11111111-1111-4111-8111-111111111111" })}\n`,
      "utf8",
    );
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(markerPath, longAgo, longAgo);

    const lease = await acquireControlLease(root);

    const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(owner.pid).toBe(process.pid);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await lease.release();
  });

  it("keeps a take-over marker whose reclaimer is still alive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-marker-live-"));
    const lockPath = path.join(root, "control.lock");
    const markerPath = path.join(root, "control.lock.reclaim");
    const stale = `${JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: "00000000-0000-4000-8000-000000000000" })}\n`;
    await writeFile(lockPath, stale, "utf8");
    await writeFile(
      markerPath,
      `${JSON.stringify({ pid: process.pid, token: "22222222-2222-4222-8222-222222222222" })}\n`,
      "utf8",
    );

    await expect(acquireControlLease(root)).rejects.toThrow("is held by PID");
    // A live reclaimer's marker is untouched, and so is the stale lock it protects.
    await expect(readFile(lockPath, "utf8")).resolves.toBe(stale);
  });

  it("reclaims a lock whose owner PID is a zombie", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { spawn } = await import("node:child_process");
    const holder = spawn(
      "sh",
      ["-c", `${JSON.stringify(process.execPath)} -e 'process.exit(0)' & echo $!; exec sleep 30`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const pid = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      holder.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
        const line = stdout.trim();
        if (/^\d+$/.test(line)) {
          resolve(Number(line));
        }
      });
      holder.once("error", reject);
      holder.once("exit", (code) => {
        reject(new Error(`zombie holder exited ${code}`));
      });
    });
    try {
      const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-zombie-"));
      const lockPath = path.join(root, "control.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid,
          token: "00000000-0000-4000-8000-000000000000",
          started: "Wed Jan  1 00:00:00 2020",
        })}\n`,
        "utf8",
      );
      const lease = await acquireControlLease(root);
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid: number;
        token: string;
      };
      expect(owner.pid).toBe(process.pid);
      await lease.release();
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("reclaims a well-formed stale owner whose PID is dead", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-stale-"));
    const lockPath = path.join(root, "control.lock");
    const stale = `${JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER,
      token: "00000000-0000-4000-8000-000000000000",
    })}\n`;
    await writeFile(lockPath, stale, "utf8");
    const lease = await acquireControlLease(root);
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      token: string;
    };
    expect(owner).toMatchObject({ pid: process.pid, token: expect.any(String) });
    await lease.release();
  });

  it("records the process start time in a newly acquired lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-started-"));
    const lease = await acquireControlLease(root);
    const owner = JSON.parse(await readFile(path.join(root, "control.lock"), "utf8")) as {
      pid: number;
      token: string;
      started?: string;
    };
    expect(owner).toMatchObject({ pid: process.pid, started: expect.any(String) });
    await lease.release();
  });

  it("reclaims a lock whose live PID was recycled by an unrelated process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-recycled-"));
    const lockPath = path.join(root, "control.lock");
    // Our own PID is alive, but the recorded start time cannot be ours:
    // the lock owner died and its PID was reused.
    const recycled = `${JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000000",
      started: "Wed Jan  1 00:00:00 2020",
    })}\n`;
    await writeFile(lockPath, recycled, "utf8");
    const lease = await acquireControlLease(root);
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      token: string;
      started?: string;
    };
    expect(owner.pid).toBe(process.pid);
    expect(owner.started).not.toBe("Wed Jan  1 00:00:00 2020");
    await lease.release();
  });

  it("keeps refusing a live legacy owner that records no start time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-legacy-"));
    const lockPath = path.join(root, "control.lock");
    // Legacy format without `started`: PID-only aliveness, our PID is alive.
    const legacy = `${JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000000",
    })}\n`;
    await writeFile(lockPath, legacy, "utf8");
    await expect(acquireControlLease(root)).rejects.toThrow("already running");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(legacy);
  });

  it("refuses a live owner whose recorded start time still matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-live-"));
    const first = await acquireControlLease(root);
    await expect(acquireControlLease(root)).rejects.toThrow("already running");
    await first.release();
  });

  it("settles concurrent stale-lock reclaim with exactly one owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-reclaim-race-"));
    const lockPath = path.join(root, "control.lock");
    const stale = `${JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER,
      token: "00000000-0000-4000-8000-000000000000",
      started: "Wed Jan  1 00:00:00 2020",
    })}\n`;
    await writeFile(lockPath, stale, "utf8");
    const results = await Promise.allSettled([
      acquireControlLease(root),
      acquireControlLease(root),
      acquireControlLease(root),
    ]);
    const acquired = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireControlLease>>> =>
        result.status === "fulfilled",
    );
    expect(acquired).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      token: string;
    };
    expect(owner).toMatchObject({ pid: process.pid, token: expect.any(String) });
    await acquired[0]!.value.release();
  });
});
