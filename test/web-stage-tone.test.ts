import { describe, expect, it } from "vitest";
import { isBehind, stageTone } from "../web/src/components/stage-stepper/tone.js";
import type { StageState } from "../web/src/stages.js";

const STATES: StageState[] = ["done", "current", "failed", "skipped", "pending"];

describe("stageTone", () => {
  it("has a tone for every state, and none of them empty", () => {
    for (const state of STATES) {
      const tone = stageTone(state);
      expect(tone.dot, state).toBeTruthy();
      expect(tone.text, state).toBeTruthy();
      expect(tone.connector, state).toBeTruthy();
      expect(tone.spoken, state).toContain("（");
    }
  });

  it("gives each state its own dot colour", () => {
    const dots = STATES.map((state) => stageTone(state).dot);
    expect(new Set(dots).size).toBeGreaterThanOrEqual(4);
  });

  it("says what each state means to a screen reader", () => {
    expect(stageTone("done").spoken).toBe("（已完成）");
    expect(stageTone("current").spoken).toBe("（进行中）");
    expect(stageTone("failed").spoken).toBe("（在此停止）");
    expect(stageTone("skipped").spoken).toBe("（已跳过）");
    expect(stageTone("pending").spoken).toBe("（未开始）");
  });
});

describe("isBehind", () => {
  it("counts only the states that are already past", () => {
    expect(STATES.filter(isBehind)).toEqual(["done", "skipped"]);
  });
});
