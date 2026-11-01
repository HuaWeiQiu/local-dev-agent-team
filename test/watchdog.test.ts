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
