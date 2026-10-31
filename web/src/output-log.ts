import type { RunEvent } from "./types";

export const OUTPUT_LOG_MAX_CHARS = 200_000;

export interface OutputLog {
  text: string;
  /** Output events that are missing or cut off at the head of `text`. */
  omittedEvents: number;
  /** Number of stdout/stderr events in the ledger, including omitted ones. */
  eventCount: number;
}

export function isOutputEvent(event: RunEvent): boolean {
  return event.type === "agent.stdout" || event.type === "agent.stderr";
}

/**
 * Concatenates agent output oldest-first but keeps only the most recent
 * `maxChars` characters so the DOM node stays bounded. It walks backwards and
 * stops formatting once the window is full, so cost tracks what is kept.
 */
export function buildOutputLog(
  events: RunEvent[],
  format: (event: RunEvent) => string,
  maxChars = OUTPUT_LOG_MAX_CHARS,
): OutputLog {
  const kept: string[] = [];
  let keptChars = 0;
  let eventCount = 0;
  let keptEvents = 0;
  let full = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!isOutputEvent(event)) continue;
    eventCount += 1;
    if (full) continue;
    const piece = format(event);
    const room = maxChars - keptChars;
    if (piece.length >= room) {
      if (room > 0) kept.push(piece.slice(piece.length - room));
      full = true;
      keptEvents += piece.length === room ? 1 : 0;
      continue;
    }
    kept.push(piece);
    keptChars += piece.length;
    keptEvents += 1;
  }
  return {
    text: kept.reverse().join(""),
    omittedEvents: eventCount - keptEvents,
    eventCount,
  };
}
