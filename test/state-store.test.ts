import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maxRunHistoryEntries, RunStateStore } from "../src/state/store.js";
import { traceIdForRun } from "../src/events/store.js";
import type { RunEvent } from "../src/events/types.js";
import type { RunState } from "../src/state/types.js";

describe("run state store", () => {
  it("keeps only the most recent history entries when saving", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const store = new RunStateStore(path.join(root, "runs"));
    const state = fakeState("history-run");
    for (let index = 0; index < maxRunHistoryEntries + 100; index += 1) {
      state.history.push({
        at: new Date().toISOString(),
        status: "implementing",
        message: `entry-${index}`,
      });
    }

    await store.save(state);
    const loaded = await store.load(state.id);
    expect(loaded.history).toHaveLength(maxRunHistoryEntries);
    expect(loaded.history[0]!.message).toBe("entry-100");
    expect(loaded.history.at(-1)!.message).toBe(`entry-${maxRunHistoryEntries + 99}`);
  });

  it("self-heals the save queue after a failed write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const runsDirectory = path.join(root, "runs");
    const store = new RunStateStore(runsDirectory);
    // Force the first save to fail: the run directory path is a file.
    await mkdir(runsDirectory, { recursive: true });
    const blocker = path.join(runsDirectory, "blocked-run");
    await writeFile(blocker, "not a directory", "utf8");
    await expect(store.save(fakeState("blocked-run"))).rejects.toThrow();

    // After the blocker is gone the same store must keep saving.
    await rm(blocker);
    await store.save(fakeState("blocked-run"));
    expect((await store.load("blocked-run")).id).toBe("blocked-run");
    await store.save(fakeState("later-run"));
    expect((await store.load("later-run")).id).toBe("later-run");
  });

  it("keeps saving when the event sink throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const store = new RunStateStore(path.join(root, "runs"), {
      append: () => {
        throw new Error("sqlite closed");
      },
    });
    const state = fakeState("sink-run");
    await store.save(state);
    expect((await store.load(state.id)).id).toBe(state.id);
    await store.save(fakeState("sink-run-2"));
    expect((await store.load("sink-run-2")).id).toBe("sink-run-2");
  });

  it("emits run.updated only after state.json is durable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const runsDirectory = path.join(root, "runs");
    const observed: string[] = [];
    const store = new RunStateStore(runsDirectory, {
      append: (event) => {
        // Throws if state.json is not on disk yet when the event fires.
        observed.push(
          JSON.parse(readFileSync(path.join(runsDirectory, event.runId, "state.json"), "utf8"))
            .id as string,
        );
        return event as RunEvent;
      },
    });
    const state = fakeState("durable-run");
    await store.save(state);
    expect(observed).toEqual([state.id]);
  });

  it("discards quarantine leftovers from a crashed delete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const store = new RunStateStore(path.join(root, "runs"));
    const doomed = fakeState("doomed-run");
    await store.save(doomed);
    const healthy = fakeState("healthy-run");
    await store.save(healthy);

    const paths = await store.quarantine(doomed.id);
    // Simulate a crash: neither restoreQuarantined nor removeQuarantined ran.
    expect(await store.discardQuarantineLeftovers()).toBe(1);
    await expect(store.load(doomed.id)).rejects.toThrow();
    await expect(
      rm(paths.quarantined, { recursive: true }),
    ).rejects.toThrow();
    // A second sweep is a no-op and healthy runs are untouched.
    expect(await store.discardQuarantineLeftovers()).toBe(0);
    expect((await store.list()).map((state) => state.id)).toEqual([healthy.id]);
  });

  it("rejects invalid state documents without breaking list()", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const runsDirectory = path.join(root, "runs");
    const store = new RunStateStore(runsDirectory);
    const good = fakeState("good-run");
    await store.save(good);

    const badDirectory = path.join(runsDirectory, "bad-run");
    await mkdir(badDirectory, { recursive: true });
    const broken = JSON.parse(JSON.stringify(fakeState("bad-run"))) as Record<string, unknown>;
    broken.status = "not-a-real-status";
    await writeFile(path.join(badDirectory, "state.json"), JSON.stringify(broken), "utf8");

    await expect(store.load("bad-run")).rejects.toThrow(/invalid/i);
    expect((await store.list()).map((state) => state.id)).toEqual([good.id]);
  });

  it("loads legacy documents without version/traceId and preserves unknown fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-state-"));
    const runsDirectory = path.join(root, "runs");
    const store = new RunStateStore(runsDirectory);
    const legacy = JSON.parse(JSON.stringify(fakeState("legacy-run"))) as Record<string, unknown>;
    legacy.futureField = { nested: true };
    const legacyDirectory = path.join(runsDirectory, "legacy-run");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(path.join(legacyDirectory, "state.json"), JSON.stringify(legacy), "utf8");

    const loaded = await store.load("legacy-run");
    expect(loaded.version).toBe(1);
    expect(loaded.traceId).toBe(traceIdForRun("legacy-run"));
    expect((loaded as unknown as Record<string, unknown>).futureField).toEqual({ nested: true });
  });
});

function fakeState(id: string): RunState {
  const now = new Date().toISOString();
  return {
    id,
    goal: "Bound history",
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: `agent-team/${id}/integration`,
    integrationWorktree: `/tmp/${id}`,
    status: "implementing",
    createdAt: now,
    updatedAt: now,
    profileOverrides: {},
    strategy: {
      name: "balanced",
      maxParallel: 2,
      maxReworkAttempts: 2,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
    },
    tasks: [],
    history: [],
  };
}
