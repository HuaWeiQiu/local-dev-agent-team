import { describe, expect, it } from "vitest";
import { acceptNewEvents } from "../web/src/event-merge.js";
import type { RunEvent } from "../web/src/types.js";

function event(sequence: number): RunEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    schemaVersion: 1,
    runId: "run-merge",
    type: "run.updated",
    occurredAt: "2026-08-11T18:00:00.000Z",
    payload: {},
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  };
}

describe("acceptNewEvents", () => {
  it("accepts a fresh batch in order and advances the cursor", () => {
    const result = acceptNewEvents(0, [event(2), event(1), event(3)]);
    expect(result.accepted.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(result.lastSequence).toBe(3);
  });

  it("drops events at or below the cursor and duplicates inside the batch", () => {
    const result = acceptNewEvents(3, [event(2), event(3), event(4), event(4), event(5)]);
    expect(result.accepted.map((item) => item.sequence)).toEqual([4, 5]);
    expect(result.lastSequence).toBe(5);
  });

  it("keeps the cursor when nothing is new", () => {
    expect(acceptNewEvents(7, [event(7), event(1)])).toEqual({ accepted: [], lastSequence: 7 });
    expect(acceptNewEvents(7, [])).toEqual({ accepted: [], lastSequence: 7 });
  });
});
