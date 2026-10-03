import type { RunEvent } from "./types";

export interface AcceptedEvents {
  accepted: RunEvent[];
  lastSequence: number;
}

/**
 * Ordering/dedup reducer for the SSE feed. Replays after a reconnect and the
 * live tail can overlap, so accept only events newer than `lastSequence`,
 * drop duplicates inside the batch and return them in sequence order.
 */
export function acceptNewEvents(lastSequence: number, incoming: readonly RunEvent[]): AcceptedEvents {
  const seen = new Set<number>();
  const accepted: RunEvent[] = [];
  for (const event of incoming) {
    if (event.sequence <= lastSequence || seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    accepted.push(event);
  }
  accepted.sort((left, right) => left.sequence - right.sequence);
  const last = accepted.at(-1);
  return { accepted, lastSequence: last ? last.sequence : lastSequence };
}
