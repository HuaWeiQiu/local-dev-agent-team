import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/events/types.js";
import { streamEvents } from "../src/server/http-sse.js";

function event(sequence: number, runId = "r1"): RunEvent {
  return {
    id: `e${sequence}`,
    schemaVersion: 1,
    runId,
    type: "flow.node",
    occurredAt: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
    payload: {},
    sequence,
    traceId: "t",
    spanId: "s",
  } as RunEvent;
}

function request(url: string, headers: Record<string, string> = {}) {
  const emitter = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (emitter as unknown as { url: string }).url = url;
  (emitter as unknown as { headers: Record<string, string> }).headers = headers;
  return emitter;
}

function response() {
  const chunks: string[] = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      head = { status, headers };
      return res;
    },
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => res,
  };
  return {
    res: res as unknown as ServerResponse,
    chunks,
    head: () => head,
  };
}

function supervisor(pages: RunEvent[][], subscribe?: (listener: (event: RunEvent) => void) => () => void) {
  let index = 0;
  return {
    events: {
      listAfter: () => {
        const page = pages[index] ?? [];
        index += 1;
        return page;
      },
      subscribe: subscribe ?? (() => () => undefined),
    },
  } as never;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("streamEvents", () => {
  it("rejects a cursor that is not a non-negative integer", () => {
    expect(() => streamEvents(request("/events?after=-1"), response().res, supervisor([[]]))).toThrow(
      "Event cursor must be a non-negative integer",
    );
  });

  it("opens an SSE stream and replays the batch it was given", async () => {
    const out = response();
    streamEvents(request("/events"), out.res, supervisor([[event(1), event(2)]], () => () => undefined));
    await tick();

    expect(out.head()).toMatchObject({ status: 200 });
    expect(out.chunks[0]).toBe("retry: 2000\n\n");
    expect(out.chunks.join("")).toContain("id: 1");
    expect(out.chunks.join("")).toContain("id: 2");
  });

  it("takes the cursor from the url and skips other runs", async () => {
    const out = response();
    streamEvents(
      request("/events?after=5", { "last-event-id": "2" }),
      out.res,
      supervisor([[event(6, "r1"), event(7, "other")]]),
      "r1",
    );
    await tick();

    const body = out.chunks.join("");
    expect(body).toContain("id: 6");
    expect(body).not.toContain("id: 7");
  });

  it("falls back to the Last-Event-ID header when the url has no cursor", async () => {
    const out = response();
    streamEvents(
      request("/events", { "last-event-id": "9" }),
      out.res,
      supervisor([[event(10)]]),
    );
    await tick();

    expect(out.chunks.join("")).toContain("id: 10");
  });

  it("flushes what the live subscription buffered during the replay", async () => {
    const out = response();
    let notify: ((event: RunEvent) => void) | undefined;
    const subscription = (listener: (event: RunEvent) => void) => {
      notify = listener;
      return () => undefined;
    };
    streamEvents(request("/events"), out.res, supervisor([[], []], subscription));
    await tick();
    notify?.(event(3));
    await tick();

    expect(out.chunks.join("")).toContain("id: 3");
  });

  it("stops writing after the client closes the stream", async () => {
    const out = response();
    const req = request("/events");
    streamEvents(req, out.res, supervisor([[]]));
    await tick();
    req.emit("close");
    out.chunks.length = 0;
    await tick();

    expect(out.chunks).toEqual([]);
  });
});
