import { describe, expect, it } from "vitest";
import {
  blockedTaskIds,
  completedTaskIds,
  markUnfinishedBlocked,
  plannedWave,
  waveBatchKeys,
  waveStatus,
} from "../src/workflow/scheduler.js";
import type { RunState } from "../src/state/types.js";

function task(id: string, dependsOn: string[] = [], batchKey?: string) {
  return {
    id,
    title: id,
    description: "",
    dependsOn,
    ownedPaths: [`src/${id}.ts`],
    acceptanceCommands: [],
    profile: null,
    ...(batchKey ? { batchKey } : {}),
  };
}

function state(patch: Record<string, unknown> = {}): RunState {
  return {
    id: "run-1",
    strategy: { name: "balanced", maxParallel: 2 },
    checkpoints: [{ completedTaskIds: [] }],
    plan: { summary: "s", tasks: [task("T1"), task("T2")] },
    tasks: [],
    ...patch,
  } as unknown as RunState;
}

describe("completedTaskIds", () => {
  it("counts checkpointed and merged tasks", () => {
    const run = state({
      checkpoints: [{ completedTaskIds: ["T1"] }],
      tasks: [{ task: task("T2"), status: "merged" }, { task: task("T3"), status: "working" }],
    });
    const done = completedTaskIds(run as never);
    expect([...done].sort()).toEqual(["T1", "T2"]);
  });
});

describe("blockedTaskIds", () => {
  it("counts only blocked tasks", () => {
    const run = state({
      tasks: [
        { task: task("T1"), status: "blocked" },
        { task: task("T2"), status: "passed" },
      ],
    });
    expect([...blockedTaskIds(run as never)]).toEqual(["T1"]);
  });
});

describe("plannedWave", () => {
  it("schedules what is ready", () => {
    const wave = plannedWave(state() as never, new Set(), new Set());
    // maxParallel is 2, so both ready tasks fit in one wave.
    expect(wave?.map((entry) => entry.id)).toEqual(["T1", "T2"]);
  });

  it("returns nothing to do when the plan is exhausted", () => {
    // Both tasks are done, so they are also no longer startable.
    expect(
      plannedWave(state() as never, new Set(["T1", "T2"]), new Set(["T1", "T2"])),
    ).toBeUndefined();
  });

  it("returns an empty wave when something remains but nothing is ready", () => {
    // T2 waits on T1, which is started but not completed: nothing is schedulable.
    const run = state({ plan: { summary: "s", tasks: [task("T1"), task("T2", ["T1"])] } });
    expect(plannedWave(run as never, new Set(), new Set(["T1"]))).toEqual([]);
  });
});

describe("waveBatchKeys", () => {
  it("keeps one entry per shared batch", () => {
    expect(waveBatchKeys([{ batchKey: "a" }, { batchKey: "a" }, { batchKey: "b" }, {}])).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns nothing when no task names a batch", () => {
    expect(waveBatchKeys([{}, { batchKey: null }])).toEqual([]);
  });
});

describe("waveStatus", () => {
  const rejection = { status: "rejected", reason: new Error("boom") } as PromiseRejectedResult;

  it("is failed only when nothing else happened", () => {
    expect(waveStatus(rejection, 0, 0)).toBe("failed");
    expect(waveStatus(rejection, 1, 0)).toBe("passed");
    expect(waveStatus(undefined, 1, 1)).toBe("blocked");
    expect(waveStatus(undefined, 1, 0)).toBe("passed");
  });
});

describe("markUnfinishedBlocked", () => {
  it("blocks every task that is neither done nor already blocked", () => {
    const run = state({
      plan: { summary: "s", tasks: [task("T1"), task("T2"), task("T3")] },
      tasks: [
        { task: task("T1"), status: "merged" },
        { task: task("T2"), status: "blocked" },
        { task: task("T3"), status: "working" },
      ],
    });
    const blocked = new Set(["T2"]);
    expect(markUnfinishedBlocked(run as never, new Set(["T1"]), blocked)).toEqual(["T3"]);
    expect(blocked.has("T3")).toBe(true);
    const blockedState = (run as never as { tasks: { status: string; error?: string }[] }).tasks[2]!;
    expect(blockedState.status).toBe("blocked");
    expect(blockedState.error).toContain("dependency failed");
  });

  it("does nothing when everything is accounted for", () => {
    const run = state({ tasks: [{ task: task("T1"), status: "merged" }] });
    expect(markUnfinishedBlocked(run as never, new Set(["T1", "T2"]), new Set())).toEqual([]);
  });
});
