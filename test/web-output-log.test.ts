import { describe, expect, it } from "vitest";
import { buildOutputLog } from "../web/src/output-log.js";
import type { RunEvent } from "../web/src/types.js";

function event(sequence: number, type: string, chunk = ""): RunEvent {
  return {
    sequence,
    id: `event-${sequence}`,
    schemaVersion: 1,
    runId: "run",
    type,
    occurredAt: "2026-10-03T00:00:00.000Z",
    payload: { chunk },
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  };
}

const format = (item: RunEvent) => `${(item.payload as { chunk: string }).chunk}|`;

describe("buildOutputLog", () => {
  it("joins output events in order and ignores other events", () => {
    const log = buildOutputLog(
      [event(1, "agent.stdout", "a"), event(2, "run.updated"), event(3, "agent.stderr", "b")],
      format,
    );
    expect(log).toEqual({ text: "a|b|", omittedEvents: 0, eventCount: 2 });
  });

  it("keeps only the newest window and reports how many events were cut", () => {
    const events = Array.from({ length: 10 }, (_, index) => event(index + 1, "agent.stdout", `l${index}`));
    const log = buildOutputLog(events, format, 9);

    expect(log.text).toBe("l7|l8|l9|");
    expect(log.eventCount).toBe(10);
    expect(log.omittedEvents).toBe(7);
  });

  it("trims a single oversized chunk from its head", () => {
    const log = buildOutputLog([event(1, "agent.stdout", "0123456789")], format, 4);

    expect(log.text).toBe("89|".padStart(4, "7"));
    expect(log.omittedEvents).toBe(1);
  });

  it("does not format events older than the retained window", () => {
    let calls = 0;
    const events = Array.from({ length: 1_000 }, (_, index) => event(index + 1, "agent.stdout", "x"));
    buildOutputLog(events, (item) => {
      calls += 1;
      return format(item);
    }, 20);

    expect(calls).toBeLessThan(20);
  });
});
