import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/events/types.js";
import { buildOtlpTraceExport } from "../src/observability/otlp.js";

function event(patch: Partial<RunEvent> & { payload?: unknown } = {}): RunEvent {
  return {
    id: "e1",
    schemaVersion: 1,
    runId: "r1",
    type: "agent.invocation.completed",
    occurredAt: "2026-11-02T00:00:10.000Z",
    payload: {},
    sequence: 4,
    traceId: "trace-1",
    spanId: "span-1",
    ...patch,
  } as RunEvent;
}

function spans(events: RunEvent[]): Array<Record<string, unknown>> {
  const exported = buildOtlpTraceExport(events, "project") as {
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
  };
  return exported.resourceSpans[0]!.scopeSpans[0]!.spans;
}

describe("buildOtlpTraceExport", () => {
  it("names the project in the resource attributes", () => {
    const exported = buildOtlpTraceExport([], "my-project") as {
      resourceSpans: Array<{ resource: { attributes: Array<Record<string, unknown>> } }>;
    };

    expect(JSON.stringify(exported.resourceSpans[0]!.resource.attributes)).toContain("my-project");
  });

  it("maps an invocation to an invoke_agent span with timing from the event", () => {
    const [span] = spans([
      event({ payload: { durationMs: 2_500, model: "gpt-5", usage: { inputTokens: 10 } } }),
    ]);

    expect(span).toMatchObject({ name: "invoke_agent", kind: 1, traceId: "trace-1" });
    expect(Number(span!.endTimeUnixNano)).toBeGreaterThan(Number(span!.startTimeUnixNano));
    const attributes = JSON.stringify(span!.attributes);
    expect(attributes).toContain("gen_ai.request.model");
    expect(attributes).toContain("gen_ai.usage.input_tokens");
    expect(attributes).toContain("invoke_agent");
  });

  it("keeps a non-invocation event under its own name", () => {
    const [span] = spans([event({ type: "run.created", payload: {} })]);

    expect(span!.name).toBe("run.created");
  });

  it("marks a failed payload as an error span with its message", () => {
    const [span] = spans([event({ payload: { success: false, error: "boom" } })]);

    expect(span!.status).toMatchObject({ code: 2, message: "boom" });
  });

  it("marks a crashed event as an error span without a message", () => {
    const [span] = spans([event({ type: "agent.invocation.crashed", payload: {} })]);

    expect(span!.status).toMatchObject({ code: 2, message: "operation failed" });
  });

  it("leaves a healthy span unset and tolerates a non-record payload", () => {
    const [span] = spans([event({ payload: "not-a-record" })]);

    expect(span!.status).toEqual({ code: 1 });
  });

  it("falls back to zero timing for an unparsable timestamp", () => {
    const [span] = spans([event({ occurredAt: "nope", payload: {} })]);

    expect(span!.endTimeUnixNano).toBe("0");
  });
});
