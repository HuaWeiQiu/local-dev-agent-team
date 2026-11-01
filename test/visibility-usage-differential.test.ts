// Differential pin for the foldRunUsage split: the pre-split implementation
// (test/support/usage-reference.ts, frozen from the commit before the split)
// and the current one must agree on the whole returned structure for every
// input, not just on the numbers a happy-path test happens to look at.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/events/types.js";
import { foldRunUsage } from "../src/visibility/usage.js";
import { foldRunUsage as foldRunUsageBefore } from "./support/usage-reference.js";

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

function outcomeOf(fold: (events: readonly RunEvent[]) => unknown, events: RunEvent[]): Outcome {
  try {
    return { ok: true, value: fold(events) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.constructor.name : String(error) };
  }
}

/**
 * Structural diff that also pins key order and distinguishes -0 from 0, so a
 * changed output shape (a renamed field, a reordered line, a lost key) fails.
 */
function diff(left: unknown, right: unknown, path = "$"): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return `${path}: ${String(left)} (${typeof left}) !== ${String(right)} (${typeof right})`;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return `${path}: array-ness differs (${Array.isArray(left)} vs ${Array.isArray(right)})`;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.join("\u0000") !== rightKeys.join("\u0000")) {
    return `${path}: keys [${leftKeys.join(",")}] !== [${rightKeys.join(",")}]`;
  }
  for (const key of leftKeys) {
    const found = diff(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (found) return found;
  }
  return undefined;
}

function compare(events: RunEvent[]): string | undefined {
  const before = outcomeOf(foldRunUsageBefore, events);
  const after = outcomeOf(foldRunUsage, events);
  if (before.ok !== after.ok) {
    return `outcome kind differs: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`;
  }
  if (!before.ok && !after.ok) {
    return before.error === after.error ? undefined : `errors differ: ${before.error} vs ${after.error}`;
  }
  if (!before.ok || !after.ok) return undefined;
  return diff(before.value, after.value);
}

/** mulberry32: a seeded generator, so a failing case is reproducible from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EVENT_TYPES = [
  "agent.invocation.completed",
  "agent.invocation.completed",
  "agent.invocation.completed",
  "agent.invocation.completed",
  "run.updated",
  "task.started",
  "agent.invocation.started",
  "AGENT.INVOCATION.COMPLETED",
  "",
  " agent.invocation.completed",
];

const ROLES = [undefined, "worker", "architect", "", "unknown", "worker", null, 7];
const PROFILES = [undefined, "codex", "claude", "", "codex", null];
const MODELS = [undefined, "m1", "m2", "", "m1", null];
const ARTIFACT_KEYS = [
  undefined,
  "tasks/T1/attempt-1/worker",
  "tasks/T1/attempt-2/worker",
  "recoveries/1/tasks/T2/attempt-2/worker",
  "tasks/T2/attempt-10/x",
  "tasks//attempt-1/x",
  "tasks/T3/attempt-1",
  "architect",
  "",
  "tasks/T1/attempt-a/x",
];
const NUMBERS = [
  undefined,
  0,
  1,
  -5,
  3.5,
  -0.25,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER * 2,
  Number.MIN_SAFE_INTEGER,
  1e12,
  -1e-9,
];
const SUCCESSES = [undefined, true, false, false, true, null];

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)] as T;
}

const COSTS = [undefined, 0, 1, 0.5, -3, 1e9, 1e-9, null];

function usageFor(rand: () => number): unknown {
  const roll = rand();
  if (roll < 0.2) return undefined;
  if (roll < 0.26) return null;
  // Non-nullish but not a usage block: `?.` and a plain read must still agree.
  if (roll < 0.31) return "not-a-usage-object";
  const usage: Record<string, unknown> = {};
  if (rand() < 0.85) usage.inputTokens = pick(rand, NUMBERS);
  if (rand() < 0.35) usage.cachedInputTokens = pick(rand, NUMBERS);
  if (rand() < 0.8) usage.outputTokens = pick(rand, NUMBERS);
  if (rand() < 0.55) usage.reportedCostUsd = pick(rand, COSTS);
  if (rand() < 0.05) usage.unknownField = "odd";
  return usage;
}

function payloadFor(rand: () => number): unknown {
  const roll = rand();
  if (roll < 0.03) return undefined;
  if (roll < 0.05) return null;
  return {
    role: pick(rand, ROLES),
    profile: pick(rand, PROFILES),
    model: pick(rand, MODELS),
    artifactKey: pick(rand, ARTIFACT_KEYS),
    durationMs: pick(rand, NUMBERS),
    success: pick(rand, SUCCESSES),
    usage: usageFor(rand),
  };
}

function eventsFor(rand: () => number, count: number): RunEvent[] {
  const events: RunEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push({
      id: `e${index}`,
      schemaVersion: 1,
      runId: "r1",
      type: pick(rand, EVENT_TYPES),
      occurredAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      payload: payloadFor(rand),
      sequence: index + 1,
      traceId: "t",
      spanId: "s",
    });
  }
  return events;
}

describe("foldRunUsage matches the pre-split implementation", () => {
  const cases: Array<{ seed: number; size: number }> = [];
  const generatorRand = generator(0x5eed_c0de);
  for (let index = 0; index < 500; index += 1) {
    cases.push({ seed: 0x9e37_79b9 + index * 7919, size: Math.floor(generatorRand() * 14) });
  }

  it("agrees on 500 randomised histories (mixed types, missing fields, negative and huge numbers)", () => {
    const failures: string[] = [];
    let compared = 0;
    for (const { seed, size } of cases) {
      const rand = generator(seed);
      const events = eventsFor(rand, size);
      const found = compare(events);
      compared += 1;
      if (found) failures.push(`seed ${seed} (${size} events): ${found}`);
    }
    expect(compared).toBe(500);
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("agrees on empty and degenerate histories", () => {
    const degenerate: RunEvent[][] = [
      [],
      eventsFor(generator(1), 0),
      [
        {
          id: "e0",
          schemaVersion: 1,
          runId: "r1",
          type: "run.updated",
          occurredAt: new Date(0).toISOString(),
          payload: {},
          sequence: 1,
          traceId: "t",
          spanId: "s",
        },
      ],
    ];
    for (const events of degenerate) expect(compare(events)).toBeUndefined();
  });

  it("agrees on the documented acceptance scenario", () => {
    const payloads: unknown[] = [
      {
        role: "worker",
        profile: "codex",
        model: "m1",
        artifactKey: "tasks/T1/attempt-1/worker",
        durationMs: 2_000,
        success: true,
        usage: { inputTokens: 100, outputTokens: 50, reportedCostUsd: 0.5 },
      },
      {
        role: "worker",
        profile: "codex",
        model: "m1",
        artifactKey: "recoveries/1/tasks/T1/attempt-2/worker",
        durationMs: 1_000,
        success: false,
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        role: "architect",
        profile: "claude",
        model: "m2",
        artifactKey: "architect",
        durationMs: 500,
        success: true,
      },
      {},
    ];
    const events = payloads.map((payload, index) => ({
      id: `e${index}`,
      schemaVersion: 1 as const,
      runId: "r1",
      type: index === payloads.length - 1 ? "run.updated" : "agent.invocation.completed",
      occurredAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      payload,
      sequence: index + 1,
      traceId: "t",
      spanId: "s",
    }));
    expect(compare(events)).toBeUndefined();
  });
});
