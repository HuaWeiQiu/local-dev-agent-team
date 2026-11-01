import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAMPLES_TO_STALL,
  changed,
  describeVerdict,
  latestQuietSince,
  progressVerdict,
  samplesSinceProgress,
  type WatchSample,
} from "../src/runtime/watchdog.js";

const MIN = 60_000;

function sample(at: number, patch: Partial<WatchSample> = {}): WatchSample {
  return {
    at,
    status: "implementing",
    taskId: "T1",
    attempts: 1,
    artifactBytes: 100,
    historyLength: 5,
    ...patch,
  };
}

describe("changed", () => {
  it("counts any fact the run recorded", () => {
    expect(changed(sample(0), sample(1))).toBe(false);
    expect(changed(sample(0), sample(1, { status: "testing" }))).toBe(true);
    expect(changed(sample(0), sample(1, { taskId: "T2" }))).toBe(true);
    expect(changed(sample(0), sample(1, { attempts: 2 }))).toBe(true);
    expect(changed(sample(0), sample(1, { artifactBytes: 200 }))).toBe(true);
    expect(changed(sample(0), sample(1, { historyLength: 6 }))).toBe(true);
  });

  it("does not treat the sample's own time as progress", () => {
    // A run that keeps being sampled is talking, not working.
    expect(changed(sample(0), sample(10 * MIN))).toBe(false);
  });
});

describe("samplesSinceProgress", () => {
  it("counts the samples that came after the last change", () => {
    // The retry lands at index 3; two quiet readings follow it.
    const samples = [
      sample(0),
      sample(1),
      sample(2),
      sample(3, { attempts: 2 }),
      sample(4, { attempts: 2 }),
      sample(5, { attempts: 2 }),
    ];
    expect(samplesSinceProgress(samples)).toBe(2);
  });

  it("is zero when the last sample differs from the one before", () => {
    expect(samplesSinceProgress([sample(0), sample(1, { taskId: "T2" })])).toBe(0);
  });

  it("counts every sample when nothing ever changed", () => {
    expect(samplesSinceProgress([sample(0), sample(1), sample(2)])).toBe(2);
  });
});

describe("latestQuietSince", () => {
  it("is the moment of the last change", () => {
    const samples = [
      sample(0),
      sample(1),
      sample(2, { attempts: 2 }),
      sample(3, { attempts: 2 }),
      sample(4, { attempts: 2 }),
    ];
    expect(latestQuietSince(samples)).toBe(2);
  });

  it("is the first sample when nothing ever changed", () => {
    expect(latestQuietSince([sample(0), sample(1), sample(2)])).toBe(0);
  });
});

describe("progressVerdict", () => {
  it("refuses to judge a single sample", () => {
    expect(progressVerdict([sample(0)])).toBe("insufficient");
    expect(progressVerdict([])).toBe("insufficient");
  });

  it("says progressing while the run keeps changing", () => {
    const samples = [sample(0), sample(MIN, { historyLength: 6 }), sample(2 * MIN, { attempts: 2 })];
    expect(progressVerdict(samples)).toBe("progressing");
  });

  it("says waiting when the quiet is long but too few samples have seen it", () => {
    const samples = [sample(0), sample(10 * MIN), sample(20 * MIN)];
    expect(samplesSinceProgress(samples)).toBe(2);
    expect(DEFAULT_SAMPLES_TO_STALL).toBe(2);
    expect(progressVerdict(samples, { samplesToStall: 5, stallAfterMs: MIN })).toBe("waiting");
  });

  it("says stalled when nothing changed for longer than the window", () => {
    const samples = [sample(0), sample(10 * MIN), sample(20 * MIN), sample(30 * MIN)];
    expect(progressVerdict(samples, { stallAfterMs: 15 * MIN })).toBe("stalled");
  });

  it("keeps a busy-but-quiet run out of stalled until the window passes", () => {
    const samples = [sample(0), sample(MIN), sample(2 * MIN)];
    expect(progressVerdict(samples, { stallAfterMs: 15 * MIN })).toBe("waiting");
  });

  it("returns to progressing when a stalled run moves again", () => {
    const samples = [
      sample(0),
      sample(10 * MIN),
      sample(20 * MIN),
      sample(21 * MIN, { attempts: 2 }),
    ];
    expect(progressVerdict(samples, { stallAfterMs: 15 * MIN })).toBe("progressing");
  });

  it("treats a fresh attempt as progress even with no new output", () => {
    // This is the case a liveness probe cannot see and a token stream hides.
    const samples = [sample(0), sample(MIN), sample(2 * MIN, { attempts: 2 })];
    expect(progressVerdict(samples, { stallAfterMs: 30 * MIN })).toBe("progressing");
  });
});

describe("describeVerdict", () => {
  it("says how long it has been quiet", () => {
    expect(describeVerdict("stalled", 20 * MIN)).toContain("20 分钟");
    expect(describeVerdict("waiting", MIN)).toContain("1 分钟");
    expect(describeVerdict("progressing", 0)).toBe("正在推进");
    expect(describeVerdict("insufficient", 0)).toContain("样本不足");
  });
});

describe("sampleRun", () => {
  it("reads the working task, its attempts, the artifacts and the history", async () => {
    const { sampleRun } = await import("../src/runtime/watchdog.js");
    const sample = sampleRun(
      {
        status: "implementing",
        tasks: [
          { task: { id: "T1" }, status: "merged", attempts: 1 },
          { task: { id: "T2" }, status: "reworking", attempts: 2 },
        ],
        history: [{}, {}, {}],
        usage: { artifactBytes: 4096 },
      },
      123,
    );
    expect(sample).toEqual({
      at: 123,
      status: "implementing",
      taskId: "T2",
      attempts: 2,
      artifactBytes: 4096,
      historyLength: 3,
    });
  });

  it("reports no task while nothing is working", async () => {
    const { sampleRun } = await import("../src/runtime/watchdog.js");
    const sample = sampleRun({ status: "awaiting-human", tasks: [], history: [] }, 1);
    expect(sample.taskId).toBeUndefined();
    expect(sample.attempts).toBe(0);
    expect(sample.artifactBytes).toBe(0);
  });
});

describe("Watchdog", () => {
  async function watchdog(samples: Record<string, WatchSample[]>, options = {}) {
    const { Watchdog } = await import("../src/runtime/watchdog.js");
    const seen: { runId: string; verdict: string }[] = [];
    let index = 0;
    const instance = new Watchdog(
      {
        liveRuns: async () => Object.keys(samples),
        sample: async (runId) => {
          const list = samples[runId]!;
          return list[Math.min(index, list.length - 1)];
        },
      },
      (finding) => {
        seen.push({ runId: finding.runId, verdict: finding.verdict });
      },
      options,
    );
    return { instance, seen, advance: () => (index += 1) };
  }

  it("says nothing while a run keeps changing", async () => {
    const { instance, seen, advance } = await watchdog({
      "run-1": [
        sample(0),
        sample(MIN, { historyLength: 6 }),
        sample(2 * MIN, { historyLength: 7 }),
      ],
    });
    await instance.tick();
    advance();
    await instance.tick();
    advance();
    await instance.tick();
    expect(seen).toEqual([]);
    expect(instance.samples("run-1")).toHaveLength(3);
  });

  it("reports a run that stopped changing once the window passes", async () => {
    const { instance, seen, advance } = await watchdog(
      { "run-1": [sample(0), sample(10 * MIN), sample(20 * MIN), sample(30 * MIN)] },
      { stallAfterMs: 15 * MIN, samplesToStall: 2 },
    );
    for (let step = 0; step < 4; step += 1) {
      await instance.tick();
      advance();
    }
    expect(seen).toEqual([{ runId: "run-1", verdict: "stalled" }]);
  });

  it("caps the samples it keeps", async () => {
    const { instance, advance } = await watchdog(
      { "run-1": Array.from({ length: 20 }, (_, at) => sample(at, { historyLength: 5 + at })) },
      { historyLimit: 4 },
    );
    for (let step = 0; step < 10; step += 1) {
      await instance.tick();
      advance();
    }
    expect(instance.samples("run-1")).toHaveLength(4);
  });

  it("skips a run whose state is gone", async () => {
    const { Watchdog } = await import("../src/runtime/watchdog.js");
    const instance = new Watchdog(
      { liveRuns: async () => ["gone"], sample: async () => undefined },
      () => undefined,
    );
    await expect(instance.tick()).resolves.toEqual([]);
  });

  it("forgets a run on request", async () => {
    const { instance, advance } = await watchdog({ "run-1": [sample(0), sample(1)] });
    await instance.tick();
    advance();
    await instance.tick();
    expect(instance.samples("run-1")).toHaveLength(2);
    instance.forget("run-1");
    expect(instance.samples("run-1")).toEqual([]);
  });

  it("does not keep the process alive when started", async () => {
    const { instance } = await watchdog({ "run-1": [sample(0)] });
    const timer = instance.start(50);
    expect(timer.hasRef?.()).toBe(false);
    clearInterval(timer);
  });
});

describe("Watchdog reporting discipline", () => {
  it("reports one stall once, and again only after the run moves", async () => {
    const { Watchdog } = await import("../src/runtime/watchdog.js");
    const seen: string[] = [];
    const timeline = [
      sample(0),
      sample(10 * MIN),
      sample(20 * MIN),
      sample(30 * MIN),
      sample(31 * MIN, { attempts: 2 }),
      sample(40 * MIN, { attempts: 2 }),
      sample(60 * MIN, { attempts: 2 }),
    ];
    let step = 0;
    const instance = new Watchdog(
      { liveRuns: async () => ["run-1"], sample: async () => timeline[step]! },
      () => {
        seen.push(timeline[step]!.at.toString());
      },
      { stallAfterMs: 15 * MIN, samplesToStall: 2 },
    );
    for (step = 0; step < timeline.length; step += 1) await instance.tick();
    // Quiet since 0, so by the third sample (20 min) it is stalled; silent while it
    // stays stalled; a retry at 31 counts as movement; quiet again by 60.
    expect(seen).toEqual(["1200000", "3600000"]);
  });
});
