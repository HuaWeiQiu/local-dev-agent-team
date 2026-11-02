import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunEvent } from "../events/types.js";
import { HttpError, singleHeader } from "./http-common.js";
import type { RunSupervisor } from "./supervisor.js";

/** The `after` query parameter wins over `Last-Event-ID`; both default to 0. */
function requestCursor(request: IncomingMessage): number {
  const headerCursor = singleHeader(request.headers["last-event-id"]);
  const url = new URL(request.url ?? "/", "http://localhost");
  const cursor = Number(url.searchParams.get("after") ?? headerCursor ?? "0");
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, "Event cursor must be a non-negative integer");
  }
  return cursor;
}

function openEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 2000\n\n");
}

/** Writes the SSE frames of one event, skipping runs the subscriber did not ask for. */
function eventWriter(response: ServerResponse, runId: string | undefined) {
  return (event: RunEvent): void => {
    if (runId && event.runId !== runId) return;
    response.write(`id: ${event.sequence}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

/**
 * Replays everything after the cursor, then flushes what the live subscription
 * buffered meanwhile. The subscription starts before the replay so nothing is
 * lost while the replay yields to the event loop.
 */
async function replayThenFlush(options: {
  cursor: number;
  runId: string | undefined;
  supervisor: RunSupervisor;
  write(event: RunEvent): void;
  buffered: RunEvent[];
  isClosed(): boolean;
  markLive(): void;
}): Promise<void> {
  let replayCursor = options.cursor;
  while (!options.isClosed()) {
    const events = options.supervisor.events.listAfter(replayCursor, options.runId, replayBatchSize);
    for (const event of events) {
      options.write(event);
      replayCursor = event.sequence;
    }
    if (events.length < replayBatchSize) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  options.markLive();
  for (const event of options.buffered.splice(0)) {
    if (event.sequence > replayCursor) options.write(event);
  }
}

export function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  supervisor: RunSupervisor,
  runId?: string,
): void {
  const cursor = requestCursor(request);
  openEventStream(response);
  const write = eventWriter(response, runId);
  let replaying = true;
  let closed = false;
  const buffered: RunEvent[] = [];
  const unsubscribe = supervisor.events.subscribe((event) => {
    if (replaying) buffered.push(event);
    else write(event);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  const stop = (): void => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.once("close", stop);

  void replayThenFlush({
    cursor,
    runId,
    supervisor,
    buffered,
    write,
    isClosed: () => closed,
    markLive: () => {
      replaying = false;
    },
  }).catch(() => {
    stop();
    response.end();
  });
}

const replayBatchSize = 1_000;
