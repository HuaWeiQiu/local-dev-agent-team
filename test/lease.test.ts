import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
    `{\"pid\":${process.pid}`,
    JSON.stringify({ pid: process.pid, token: "not-a-lease-token" }),
  ])("fails closed without replacing an incomplete or invalid lock", async (contents) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-lease-invalid-"));
    const lockPath = path.join(root, "control.lock");
    await writeFile(lockPath, contents, "utf8");
    await expect(acquireControlLease(root)).rejects.toThrow("incomplete or invalid");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(contents);
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
});
