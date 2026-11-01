/**
 * The seam between an event and a run.
 *
 * Three things have to happen in one order, and this is that order:
 *
 *   admit(trigger)   the gate decides whether the work is allowed at all;
 *   attachRun(...)   an admitted Ticket gets one Assignment, which carries a run;
 *   settleRun(...)   the Assignment ends; the Ticket keeps its own life.
 *
 * Nothing here decides policy or writes a run — it composes the pieces that do,
 * so the caller (the supervisor) stays a translator and the rules stay in one
 * place each. The service is the only writer of Tickets, which is what makes the
 * "one running Assignment" rule hold across processes.
 */

import { randomUUID } from "node:crypto";
import type { PolicySnapshot } from "./types.js";
import type { Trigger } from "../intake/types.js";
import { threadKey } from "../intake/types.js";
import { evaluateGate, type GateDecision, type OpenTicket } from "./gate.js";
import {
  acceptTrigger,
  isSubscribed,
  subscribe as subscribeTicket,
  unsubscribe as unsubscribeTicket,
  endAssignment,
  endTicket,
  openTicket,
  resumeTicket,
  runningAssignment,
  startAssignment,
  TicketError,
  type AssignmentOutcome,
  type Ticket,
  type TicketOutcome,
} from "./ticket.js";
import type { TicketStore } from "./ticket-store.js";

/** What `admit` produced: the decision, and the Ticket it landed on, if any. */
export interface Admission {
  decision: GateDecision;
  ticket?: Ticket;
}

export interface TicketServiceOptions {
  store: TicketStore;
  /** Supplies the current policy; a getter so a policy change needs no restart. */
  policy: () => PolicySnapshot;
  now?: () => Date;
  newId?: () => string;
}

export class TicketService {
  readonly #store: TicketStore;
  readonly #policy: () => PolicySnapshot;
  readonly #now: () => Date;
  readonly #newId: () => string;
  /** Serialises mutations: two admits for one Thread must not both open a Ticket. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: TicketServiceOptions) {
    this.#store = options.store;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
  }

  /**
   * The decision for one Trigger.
   *
   * A Thread an open Ticket is subscribed to takes the direct path: the Trigger
   * joins that Ticket without an Eval, because the authorization was decided when
   * the Ticket was opened and a follow-up does not re-open it. Everything else
   * goes through the gate.
   */
  async admit(input: {
    trigger: Trigger;
    addressed: boolean;
    scope?: readonly string[];
  }): Promise<Admission> {
    return await this.#serial(async () => {
      const direct = await this.#subscribedTicket(input.trigger);
      if (direct) {
        // The same event delivered twice is still one Trigger: a Subscription
        // decides where a follow-up goes, never whether a duplicate counts.
        if (direct.triggerIds.includes(input.trigger.id)) {
          return { decision: duplicateDecision(input.trigger.id) };
        }
        const joined = acceptTrigger(direct, input.trigger.id);
        await this.#store.save(joined);
        return { decision: directPassDecision(), ticket: joined };
      }
      return await this.#admitThroughGate(input);
    });
  }

  /** The open Ticket subscribed to this Trigger's Thread, if there is one. */
  async #subscribedTicket(trigger: Trigger): Promise<Ticket | undefined> {
    const thread = threadKeyOf(trigger);
    const tickets = await this.#store.list();
    return tickets.find((ticket) => isSubscribed(ticket, thread));
  }

  /** Subscribe an open Ticket to another Thread it should keep following. */
  async subscribe(ticketId: string, threadKey: string): Promise<Ticket> {
    return await this.#serial(async () => {
      const ticket = await this.#requireTicket(ticketId);
      const next = subscribeTicket(ticket, threadKey);
      await this.#store.save(next);
      return next;
    });
  }

  /** Stop following a Thread. A Ticket keeps its own Thread either way. */
  async unsubscribe(ticketId: string, threadKey: string): Promise<Ticket> {
    return await this.#serial(async () => {
      const ticket = await this.#requireTicket(ticketId);
      const next = unsubscribeTicket(ticket, threadKey);
      await this.#store.save(next);
      return next;
    });
  }

  /**
   * Decide one Trigger through the gate. An accept opens a Ticket, or adds the
   * Trigger to the Ticket already open on that Thread; a refusal changes nothing.
   */
  async #admitThroughGate(input: {
    trigger: Trigger;
    addressed: boolean;
    scope?: readonly string[];
  }): Promise<Admission> {
    {
      const thread = threadKeyOf(input.trigger);
      const tickets = await this.#store.list();
      const onThread = tickets.filter((ticket) => ticket.threadKey === thread);
      const decision = evaluateGate({
        trigger: input.trigger,
        policy: this.#policy(),
        addressed: input.addressed,
        openTickets: onThread.map(toOpenTicket),
      });
      if (decision.outcome !== "accept") return { decision };

      const existing = onThread.find((ticket) => ticket.state === "open");
      if (existing) {
        const updated = acceptTrigger(existing, input.trigger.id);
        await this.#store.save(updated);
        return { decision, ticket: updated };
      }
      const created = openTicket({
        id: this.#newId(),
        threadKey: thread,
        mandate: {
          id: this.#newId(),
          triggerId: input.trigger.id,
          policyVersion: this.#policy().version,
          scope: [...(input.scope ?? [])],
          strength: decision.strength,
          actor: input.trigger.actor,
          sourceKind: input.trigger.sourceKind,
          reliedOn: [...this.#policy().rules],
          grantedAt: this.#at(),
        },
        triggerId: input.trigger.id,
      });
      await this.#store.save(created);
      return { decision, ticket: created };
    }
  }

  /**
   * Record a Ticket that was built in memory. Idempotent: an existing record with
   * the same id is left alone, so a retried start cannot overwrite history.
   */
  async ensure(ticket: Ticket): Promise<Ticket> {
    return await this.#serial(async () => {
      const existing = await this.#store.get(ticket.id);
      if (existing) return existing;
      await this.#store.save(ticket);
      return ticket;
    });
  }

  /** Bind a run to a Ticket. This is the Assignment the run executes as. */
  async attachRun(input: { ticketId: string; runId: string }): Promise<Ticket> {
    return await this.#serial(async () => {
      const ticket = await this.#requireTicket(input.ticketId);
      const next = startAssignment(ticket, {
        id: this.#newId(),
        runId: input.runId,
        at: this.#at(),
      });
      await this.#store.save(next);
      return next;
    });
  }

  /** End the Assignment a run carried, leaving the Ticket open. */
  async settleRun(input: {
    ticketId: string;
    runId: string;
    outcome: AssignmentOutcome;
  }): Promise<Ticket> {
    return await this.#serial(async () => {
      const ticket = await this.#requireTicket(input.ticketId);
      const assignment = ticket.assignments.find(
        (entry) => entry.runId === input.runId && entry.state !== "ended",
      );
      if (!assignment) return ticket;
      const next = endAssignment(ticket, {
        id: assignment.id,
        at: this.#at(),
        outcome: input.outcome,
      });
      await this.#store.save(next);
      return next;
    });
  }

  /** End the Ticket itself, once nothing runs for it. */
  async close(input: { ticketId: string; outcome: TicketOutcome; by: string }): Promise<Ticket> {
    return await this.#serial(async () => {
      const ticket = await this.#requireTicket(input.ticketId);
      const next = endTicket(ticket, { at: this.#at(), outcome: input.outcome, by: input.by });
      await this.#store.save(next);
      return next;
    });
  }

  /** A person's message on a subscribed Thread reopens an ended Ticket. */
  async resume(input: { ticketId: string; trigger: Trigger }): Promise<Ticket> {
    return await this.#serial(async () => {
      const ticket = await this.#requireTicket(input.ticketId);
      const next = resumeTicket(ticket, {
        policy: this.#policy(),
        triggerId: input.trigger.id,
        at: this.#at(),
      });
      await this.#store.save(next);
      return next;
    });
  }

  async list(): Promise<Ticket[]> {
    return await this.#store.list();
  }

  async get(ticketId: string): Promise<Ticket | undefined> {
    return await this.#store.get(ticketId);
  }

  /** The run currently executing a Ticket, if any. */
  async runningRunId(ticketId: string): Promise<string | undefined> {
    const ticket = await this.#store.get(ticketId);
    return ticket ? runningAssignment(ticket)?.runId : undefined;
  }

  async #requireTicket(ticketId: string): Promise<Ticket> {
    const ticket = await this.#store.get(ticketId);
    if (!ticket) throw new TicketError("no-assignment", `Ticket '${ticketId}' was not found`);
    return ticket;
  }

  #at(): string {
    return this.#now().toISOString();
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(action, action);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** The Thread a Trigger belongs to, or a Thread of its own when it names none. */
function threadKeyOf(trigger: Trigger): string {
  return threadKey(
    trigger.threads[0] ?? {
      sourceKind: trigger.sourceKind,
      sourceInstanceId: trigger.sourceInstanceId,
      threadId: "",
    },
  );
}

/** A Trigger this Ticket already holds: accepted once, refused ever after. */
function duplicateDecision(triggerId: string): GateDecision {
  return {
    outcome: "ignore",
    strength: "inferred",
    reasons: [{ code: "duplicate_trigger", values: [triggerId] }],
  };
}

/**
 * A direct pass is not a judgement: the Ticket already holds the authority, and
 * this Trigger only joins it. The reason says so, so a reader of the record does
 * not mistake it for a gate decision.
 */
function directPassDecision(): GateDecision {
  return {
    outcome: "accept",
    strength: "explicit",
    reasons: [{ code: "subscription_direct_pass" }],
  };
}

function toOpenTicket(ticket: Ticket): OpenTicket {
  return {
    id: ticket.id,
    triggerIds: ticket.triggerIds,
    paths: ticket.mandate.scope,
  };
}
