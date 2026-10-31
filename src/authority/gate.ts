/**
 * The gate: the deterministic first layer of an Eval.
 *
 * A model may judge whether work is worth doing, but it may not judge whether the
 * work is *allowed*. That question is answered here, by rules over recorded facts,
 * before any assessment runs — and before any planning, so a refused request never
 * costs a planning round.
 *
 * The rules are ordered and the first match wins, which is what makes a refusal
 * legible: one code, one sentence, no combination to reason about.
 */

import type { PolicySnapshot, Reason, Strength } from "./types.js";
import type { Trigger } from "../intake/types.js";

/** What a Ticket already on the Thread would tell the gate. */
export interface OpenTicket {
  id: string;
  /** The Triggers it already owns; a Trigger may be owned once. */
  triggerIds: readonly string[];
  paths: readonly string[];
}

export interface GateInput {
  trigger: Trigger;
  policy: PolicySnapshot;
  /** Tickets currently open on the Trigger's primary Thread. */
  openTickets: readonly OpenTicket[];
  /**
   * Whether a person addressed the agent in this Trigger. A message that only
   * mentions it in passing is context, not a request.
   */
  addressed: boolean;
}

export type GateOutcome = "accept" | "ignore" | "unavailable";

export interface GateDecision {
  outcome: GateOutcome;
  /** How strong the basis is; `explicit` only when a person asked directly. */
  strength: Strength;
  reasons: Reason[];
  /** What an accept grants; absent when the gate refused. */
  mandate?: { scope: readonly string[]; strength: Strength };
}

/**
 * Decide whether this Trigger may start work. Ordered: the first rule that
 * applies decides, so every refusal has exactly one reason.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const { trigger, policy, addressed } = input;

  if (!actorAllowedByPolicy(trigger.actor.id, policy)) {
    return refuse("ignore", "actor_not_allowed", [trigger.actor.id]);
  }
  if (!addressed && !policy.allowsProactive) {
    return refuse("ignore", "proactive_disallowed", []);
  }
  if (trigger.threads.length === 0) {
    return refuse("unavailable", "no_thread", []);
  }
  if (input.openTickets.some((ticket) => ticket.triggerIds.includes(trigger.id))) {
    return refuse("ignore", "duplicate_trigger", [trigger.id]);
  }
  const strength: Strength = addressed ? "explicit" : "inferred";
  return {
    outcome: "accept",
    strength,
    reasons: [{ code: addressed ? "explicit_request" : "inferred_request" }],
    mandate: { scope: [], strength },
  };
}

function actorAllowedByPolicy(actor: string, policy: PolicySnapshot): boolean {
  return policy.allowedActors.includes("*") || policy.allowedActors.includes(actor);
}

function refuse(outcome: GateOutcome, code: string, values: readonly string[]): GateDecision {
  return {
    outcome,
    strength: "inferred",
    reasons: [values.length > 0 ? { code, values } : { code }],
  };
}

/**
 * A person's plain-language refusal, recognised so it needs no assessment.
 * The Chinese words take no `\b`: a word boundary never matches after a CJK
 * character, so `停止` would slip through.
 */
const STOP_WORDS = /^\s*(?:stop|cancel)\b|^\s*(?:停止|取消)/i;

/**
 * Whether this Trigger is a person telling the agent to stop the work on its
 * Thread. Such a request is a Decision on its own: it skips assessment entirely.
 */
export function isStopRequest(input: Pick<GateInput, "trigger" | "policy" | "addressed">): boolean {
  if (!input.addressed) return false;
  if (!actorAllowedByPolicy(input.trigger.actor.id, input.policy)) return false;
  const body = input.trigger.payload?.body;
  return typeof body === "string" && STOP_WORDS.test(body);
}

/** The decision a stop request produces. */
export function stopDecision(trigger: Trigger): GateDecision {
  return {
    outcome: "ignore",
    strength: "explicit",
    reasons: [{ code: "stop_requested", values: [trigger.id] }],
  };
}

/**
 * Read one gate decision into a sentence for the panel. Codes stay stable; the
 * words may change, so nothing branches on them.
 */
const GATE_WORDS: Record<string, (values: readonly string[]) => string> = {
  actor_not_allowed: (values) => `Actor '${values[0] ?? "?"}' is not allowed to start work`,
  proactive_disallowed: () => "Nothing starts work that nobody asked for",
  no_thread: () => "This event belongs to no Thread, so there is nothing to evaluate",
  duplicate_trigger: () => "This event already started work",
  explicit_request: () => "A person asked for this",
  inferred_request: () => "Recognised as a request",
  stop_requested: () => "A person asked to stop",
};

export function describeGateReason(reason: Reason): string {
  return GATE_WORDS[reason.code]?.(reason.values ?? []) ?? reason.code;
}
