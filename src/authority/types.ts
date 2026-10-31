/**
 * The authority vocabulary: why work may be done, and how far it may go.
 *
 * An Eval turns a batch of Triggers into a Decision. An accept grants a Mandate:
 * an immutable record of the policy that allowed it, the scope it covers and how
 * strong the basis was. A Ticket may end, but its Mandate stays valid until a
 * person stops it or the policy no longer holds it.
 *
 * Revocation is therefore a comparison, not a stored flag — `mandateRevocation`
 * answers it against the current policy every time work resumes.
 */

import type { ActorRef, SourceKind } from "../intake/types.js";

export type Decision = "accept" | "stop" | "ignore" | "unavailable";

/** How strong the basis of a Decision or a Mandate is. */
export type Strength = "explicit" | "inferred";

/** One reason a Decision was made; codes are stable, text is not. */
export interface Reason {
  code: string;
  /** Values the code needs, such as a path or a rule name. */
  values?: readonly string[];
}

/**
 * The part of the configuration a Mandate was granted under. Only what a Mandate
 * needs to be revalidated later; the rest of the policy stays where it is.
 */
export interface PolicySnapshot {
  /** Identifies one combination of rules, Source parts and accept mode. */
  version: string;
  /** Actors allowed to originate work through this Source, in its own identities. */
  allowedActors: readonly string[];
  /** Whether work nobody explicitly asked for may start. */
  allowsProactive: boolean;
  /** Rule names the policy currently holds; a Mandate records what it relied on. */
  rules: readonly string[];
}

export interface Mandate {
  id: string;
  /** The Trigger whose Eval granted this. */
  triggerId: string;
  policyVersion: string;
  /** The work this Mandate allows: owned paths, or areas by name. */
  scope: readonly string[];
  strength: Strength;
  /** Who asked, as their Source names them. */
  actor: ActorRef;
  sourceKind: SourceKind;
  /** Rule names the Decision relied on; a policy that drops one revokes it. */
  reliedOn: readonly string[];
  grantedAt: string;
}

/** Why a Mandate no longer holds. `undefined` means it still does. */
export type RevocationCode =
  | "policy-changed-rules"
  | "actor-not-allowed"
  | "proactive-disallowed";

export interface Revocation {
  code: RevocationCode;
  detail: string;
}

/** A Mandate is valid while its policy still allows its actor and every rule it relied on. */
export function mandateRevocation(
  mandate: Mandate,
  policy: PolicySnapshot,
): Revocation | undefined {
  const actor = mandate.actor.id;
  if (!policy.allowedActors.includes("*") && !policy.allowedActors.includes(actor)) {
    return {
      code: "actor-not-allowed",
      detail: `actor '${actor}' is no longer allowed to originate work`,
    };
  }
  if (mandate.strength === "inferred" && !policy.allowsProactive) {
    return {
      code: "proactive-disallowed",
      detail: "proactive work is no longer accepted",
    };
  }
  const dropped = mandate.reliedOn.filter((rule) => !policy.rules.includes(rule));
  if (dropped.length > 0) {
    return {
      code: "policy-changed-rules",
      detail: `rules no longer held: ${dropped.join(", ")}`,
    };
  }
  return undefined;
}

/** Whether work may resume under this Mandate. */
export function mandateHolds(mandate: Mandate, policy: PolicySnapshot): boolean {
  return mandateRevocation(mandate, policy) === undefined;
}

/** A Mandate is scoped: a path outside it needs a new Mandate, not a wider one. */
export function mandateCovers(mandate: Mandate, path: string): boolean {
  const normalized = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return mandate.scope.some((entry) => {
    const root = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

/** Two Mandates are the same grant when every recorded fact matches. */
export function sameMandate(left: Mandate, right: Mandate): boolean {
  return (
    left.id === right.id &&
    left.policyVersion === right.policyVersion &&
    left.strength === right.strength &&
    left.actor.id === right.actor.id &&
    left.sourceKind === right.sourceKind &&
    left.triggerId === right.triggerId &&
    left.scope.join("\u0000") === right.scope.join("\u0000") &&
    left.reliedOn.join("\u0000") === right.reliedOn.join("\u0000")
  );
}
