/**
 * What needs a person, and nothing else.
 *
 * The panel's first screen is the queue of work that cannot continue without
 * someone. Everything healthy is a count, not a row: a list that shows healthy
 * work costs attention without giving any back.
 *
 * The ordering is a judgement, not an accident — a failure that nobody can see is
 * worse than a review that waits, and both are worse than work that is merely
 * queued. `ATTENTION_ORDER` is that judgement written down.
 */

import { ticketStage, type Ticket } from "./ticket.js";

export type AttentionKind =
  | "delivery-failed"
  | "awaiting-answer"
  | "blocked"
  | "failed"
  | "awaiting-review";

export interface AttentionEntry {
  ticketId: string;
  kind: AttentionKind;
  /** What the panel says; the words may change, the kind may not. */
  headline: string;
  /** Since when it waits, when the Ticket records it. */
  since?: string;
}

/** Most urgent first: nothing moves without a person, and silence hides it. */
const ATTENTION_ORDER: readonly AttentionKind[] = [
  "delivery-failed",
  "blocked",
  "failed",
  "awaiting-answer",
  "awaiting-review",
];

const HEADLINES: Record<AttentionKind, string> = {
  "delivery-failed": "Inputs could not be delivered",
  blocked: "Blocked, waiting on a person",
  failed: "Failed, waiting on a person",
  "awaiting-answer": "Awaiting an answer",
  "awaiting-review": "Awaiting review",
};

/**
 * The one thing a person must do for this Ticket, if any. A Ticket that needs
 * nothing from a person returns nothing, however busy it is.
 */
export function attentionOf(ticket: Ticket): AttentionEntry | undefined {
  const kind = attentionKind(ticket);
  if (!kind) return undefined;
  const since = latestEnd(ticket);
  return {
    ticketId: ticket.id,
    kind,
    headline: HEADLINES[kind],
    ...(since ? { since } : {}),
  };
}

function attentionKind(ticket: Ticket): AttentionKind | undefined {
  if (ticket.state === "ended") return undefined;
  if (ticket.delivery?.error) return "delivery-failed";
  const stage = ticketStage(ticket);
  if (stage === "person/blocked") {
    return latestOutcome(ticket) === "failed" ? "failed" : "blocked";
  }
  if (stage === "person/answer") return "awaiting-answer";
  if (stage === "person/review") return "awaiting-review";
  return undefined;
}

/**
 * The queue, most urgent first, then oldest first inside one kind — work that has
 * waited longest is the work someone forgot.
 */
export function attentionQueue(tickets: readonly Ticket[]): AttentionEntry[] {
  const entries = tickets
    .map((ticket) => attentionOf(ticket))
    .filter((entry): entry is AttentionEntry => Boolean(entry));
  return entries.sort((left, right) => {
    const byKind = rank(left.kind) - rank(right.kind);
    if (byKind !== 0) return byKind;
    return (left.since ?? "") < (right.since ?? "") ? -1 : 1;
  });
}

function rank(kind: AttentionKind): number {
  return ATTENTION_ORDER.indexOf(kind);
}

/** Stages that are actually moving: queued for a slot, or running. */
const MOVING_STAGES = new Set(["working", "working/queued"]);

/**
 * How much is moving without needing anyone: a number, not a row. A Ticket that
 * finished a turn and waits for the next Trigger is idle, not working, so it is
 * counted nowhere — it needs no one and is doing nothing.
 */
export function workingCount(tickets: readonly Ticket[]): number {
  return tickets.filter((ticket) => MOVING_STAGES.has(ticketStage(ticket))).length;
}

function latestOutcome(ticket: Ticket): string | undefined {
  return [...ticket.assignments].reverse().find((entry) => entry.state === "ended")?.outcome;
}

function latestEnd(ticket: Ticket): string | undefined {
  return [...ticket.assignments].reverse().find((entry) => entry.state === "ended")?.endedAt;
}
