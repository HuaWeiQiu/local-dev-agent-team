/**
 * The Ticket: the durable unit of authorized work.
 *
 * A Ticket outlives the executions it causes. One Ticket may be worked on many
 * times — a failed Assignment is retried, a person's later message resumes an
 * ended Ticket — and each of those is one `Assignment` in its history. Their
 * states are independent: an Assignment ending does not end the Ticket, and a
 * Ticket ending does not rewrite what its Assignments did.
 *
 * Everything here is a pure transition over an immutable record, so the
 * "one Ticket, several Assignments" property can be proved without a server.
 */

import type { Mandate, PolicySnapshot } from "./types.js";
import { mandateRevocation } from "./types.js";

export type TicketState = "open" | "ended";

export type AssignmentState = "pending" | "running" | "ended";

/** How an Assignment finished, from the executor's point of view. */
export type AssignmentOutcome = "completed" | "failed" | "blocked" | "interrupted";

/** How a Ticket ended. `stopped` is the only one a person causes directly. */
export type TicketOutcome = "merged" | "closed" | "dropped" | "stopped";

export interface Assignment {
  id: string;
  /** The run that carries this Assignment. */
  runId: string;
  startedAt: string;
  state: AssignmentState;
  endedAt?: string;
  outcome?: AssignmentOutcome;
}

export interface TicketEnd {
  at: string;
  outcome: TicketOutcome;
  /** Who ended it: a person's stop records the actor. */
  by: string;
}

export interface Ticket {
  id: string;
  /** The Thread this Ticket was opened on. */
  threadKey: string;
  mandate: Mandate;
  /** Every Trigger this Ticket has accepted; a Trigger is accepted once. */
  triggerIds: readonly string[];
  state: TicketState;
  assignments: readonly Assignment[];
  ended?: TicketEnd;
}

export class TicketError extends Error {
  constructor(
    readonly code:
      | "already-open-assignment"
      | "no-assignment"
      | "ended"
      | "not-ended"
      | "mandate-revoked"
      | "stopped",
    message: string,
  ) {
    super(message);
    this.name = "TicketError";
  }
}

/** A Ticket is created by an accept, never by a caller directly. */
export function openTicket(input: {
  id: string;
  threadKey: string;
  mandate: Mandate;
  triggerId: string;
}): Ticket {
  return {
    id: input.id,
    threadKey: input.threadKey,
    mandate: input.mandate,
    triggerIds: [input.triggerId],
    state: "open",
    assignments: [],
  };
}

/** The Assignment currently working, if any. */
export function runningAssignment(ticket: Ticket): Assignment | undefined {
  return ticket.assignments.find((assignment) => assignment.state !== "ended");
}

/**
 * Start a new Assignment. A Ticket has one at a time: two concurrent Assignments
 * would both hold the same authority over the same work.
 */
export function startAssignment(
  ticket: Ticket,
  input: { id: string; runId: string; at: string },
): Ticket {
  requireOpen(ticket);
  if (runningAssignment(ticket)) {
    throw new TicketError(
      "already-open-assignment",
      `Ticket '${ticket.id}' already has a running Assignment`,
    );
  }
  return {
    ...ticket,
    assignments: [
      ...ticket.assignments,
      { id: input.id, runId: input.runId, startedAt: input.at, state: "running" },
    ],
  };
}

/** End one Assignment. The Ticket keeps running its own life. */
export function endAssignment(
  ticket: Ticket,
  input: { id: string; at: string; outcome: AssignmentOutcome },
): Ticket {
  const target = ticket.assignments.find((assignment) => assignment.id === input.id);
  if (!target) {
    throw new TicketError("no-assignment", `Ticket '${ticket.id}' has no Assignment '${input.id}'`);
  }
  if (target.state === "ended") return ticket;
  return {
    ...ticket,
    assignments: ticket.assignments.map((assignment) =>
      assignment.id === input.id
        ? { ...assignment, state: "ended" as const, endedAt: input.at, outcome: input.outcome }
        : assignment,
    ),
  };
}

/** End the Ticket itself; a running Assignment must be ended first. */
export function endTicket(
  ticket: Ticket,
  input: { at: string; outcome: TicketOutcome; by: string },
): Ticket {
  if (ticket.state === "ended") return ticket;
  if (runningAssignment(ticket)) {
    throw new TicketError(
      "already-open-assignment",
      `Ticket '${ticket.id}' cannot end while an Assignment runs`,
    );
  }
  return {
    ...ticket,
    state: "ended",
    ended: { at: input.at, outcome: input.outcome, by: input.by },
  };
}

/**
 * Resume an ended Ticket under its Mandate. A person's stop is final: only a new
 * Mandate revives it, which means a new Ticket.
 */
export function resumeTicket(
  ticket: Ticket,
  input: { policy: PolicySnapshot; triggerId: string; at: string },
): Ticket {
  if (ticket.state !== "ended") return acceptTrigger(ticket, input.triggerId);
  if (ticket.ended?.outcome === "stopped") {
    throw new TicketError("stopped", `Ticket '${ticket.id}' was stopped by a person`);
  }
  const revocation = mandateRevocation(ticket.mandate, input.policy);
  if (revocation) {
    throw new TicketError(
      "mandate-revoked",
      `Ticket '${ticket.id}' cannot resume: ${revocation.code} (${revocation.detail})`,
    );
  }
  const { ended: _ended, ...rest } = ticket;
  return acceptTrigger({ ...rest, state: "open" }, input.triggerId);
}

/** A Ticket accepts each Trigger once. */
export function acceptTrigger(ticket: Ticket, triggerId: string): Ticket {
  if (ticket.triggerIds.includes(triggerId)) return ticket;
  return { ...ticket, triggerIds: [...ticket.triggerIds, triggerId] };
}

/** Every Assignment this Ticket ever had, oldest first. */
export function assignmentHistory(ticket: Ticket): readonly Assignment[] {
  return ticket.assignments;
}

/** Whether this Ticket has been worked on more than once. */
export function hasMultipleAssignments(ticket: Ticket): boolean {
  return ticket.assignments.length > 1;
}

function requireOpen(ticket: Ticket): void {
  if (ticket.state === "ended") {
    throw new TicketError("ended", `Ticket '${ticket.id}' ended at ${ticket.ended?.at ?? "?"}`);
  }
}

export type TicketStage =
  | "person/delivery"
  | "person/answer"
  | "person/review"
  | "person/blocked"
  | "working/queued"
  | "idle"
  | "working"
  | "ended";

/**
 * The stage table, read top to bottom: the first matching row wins. A `person`
 * stage means the Ticket cannot continue without human input.
 */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.state === "ended") return "ended";
  const latest = latestEndedAssignment(ticket);
  // Waiting on a person outranks everything below: a blocked or failed
  // Assignment does not change until someone answers.
  if (latest && isWaitingOnPerson(latest)) return "person/blocked";
  // An interrupted Assignment is picked up again; a running one is working now.
  if (runningAssignment(ticket) || latest?.outcome === "interrupted") return "working";
  // An Assignment that ended with no question outstanding leaves the Ticket idle;
  // one that never started is queued.
  return latest ? "idle" : "working/queued";
}

function isWaitingOnPerson(assignment: Assignment): boolean {
  return assignment.outcome === "blocked" || assignment.outcome === "failed";
}

function latestEndedAssignment(ticket: Ticket): Assignment | undefined {
  return [...ticket.assignments].reverse().find((assignment) => assignment.state === "ended");
}
