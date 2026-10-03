import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunEvent } from "../events/types.js";
import { HttpError, singleHeader } from "./http-common.js";
import type { RunSupervisor } from "./supervisor.js";

export function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  supervisor: RunSupervisor,
  runId?: string,
): void {
  const headerCursor = singleHeader(request.headers["last-event-id"]);
  const url = new URL(request.url ?? "/", "http://localhost");
  const cursorText = url.searchParams.get("after") ?? headerCursor ?? "0";
  const cursor = Number(cursorText);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, "Event cursor must be a non-negative integer");
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 2000\n\n");
  const write = (event: RunEvent): void => {
    if (!runId || event.runId === runId) {
      response.write(`id: ${event.sequence}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  // Subscribe before replaying so events appended while the replay yields to
  // the event loop are buffered instead of lost; they are flushed afterwards,
  // skipping anything the replay already delivered.
  let replaying = true;
  let closed = false;
  const buffered: RunEvent[] = [];
  const unsubscribe = supervisor.events.subscribe((event) => {
    if (replaying) {
      buffered.push(event);
    } else {
      write(event);
    }
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });

  void (async () => {
    let replayCursor = cursor;
    while (!closed) {
      const events = supervisor.events.listAfter(replayCursor, runId, replayBatchSize);
      for (const event of events) {
        write(event);
        replayCursor = event.sequence;
      }
      if (events.length < replayBatchSize) {
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    replaying = false;
    for (const event of buffered.splice(0)) {
      if (event.sequence > replayCursor) {
        write(event);
      }
    }
  })().catch(() => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  });
}

const replayBatchSize = 1_000;
