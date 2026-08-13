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
  let replayCursor = cursor;
  while (true) {
    const events = supervisor.events.listAfter(replayCursor, runId, 1_000);
    for (const event of events) {
      write(event);
      replayCursor = event.sequence;
    }
    if (events.length < 1_000) {
      break;
    }
  }
  const unsubscribe = supervisor.events.subscribe(write);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
