/**
 * The policy a Mandate is granted under, derived from the configuration.
 *
 * We have no versioned policy store of our own yet, so the snapshot is computed
 * from the facts that actually decide whether work may proceed: the project, the
 * roles the configuration declares, the strategy in force and the approval gates.
 * The version is a hash of exactly those facts, which makes "the policy changed"
 * a question the system can answer without a separate registry.
 */

import { createHash } from "node:crypto";
import type { AgentTeamConfig } from "../config/schema.js";
import type { PolicySnapshot } from "./types.js";

/** The facts a Mandate depends on; anything outside this list cannot revoke it. */
export interface PolicyFacts {
  project: string;
  strategy: string;
  roles: readonly string[];
  gates: readonly string[];
  /** Operators allowed to approve, when the configuration names any. */
  allowedActors: readonly string[];
  allowsProactive: boolean;
  /** Named rules in force; a Mandate records the ones its Decision relied on. */
  rules: readonly string[];
}

/** A stable, order-independent digest of the facts. */
export function policyVersion(facts: PolicyFacts): string {
  const canonical = JSON.stringify({
    project: facts.project,
    strategy: facts.strategy,
    roles: [...facts.roles].sort(),
    gates: [...facts.gates].sort(),
    allowedActors: [...facts.allowedActors].sort(),
    allowsProactive: facts.allowsProactive,
    rules: [...facts.rules].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Read the facts out of a loaded configuration. */
export function policyFactsFrom(
  config: AgentTeamConfig,
  strategyName: string,
): PolicyFacts {
  const roles = Object.keys(config.roles ?? {});
  const gates = ["plan", "final"];
  return {
    project: config.project.name,
    strategy: strategyName,
    roles,
    gates,
    // No configuration names approvers yet, so every operator is allowed and a
    // Mandate records the actor that actually answered.
    allowedActors: ["*"],
    // Nothing starts work nobody asked for; proactive work stays off until a
    // Source exists that a person has allowed.
    allowsProactive: false,
    rules: [...gates.map((gate) => `gate:${gate}`), `strategy:${strategyName}`],
  };
}

export function policySnapshot(facts: PolicyFacts): PolicySnapshot {
  return {
    version: policyVersion(facts),
    allowedActors: [...facts.allowedActors],
    allowsProactive: facts.allowsProactive,
    rules: [...facts.rules],
  };
}

/** Whether an actor matches an allowed entry; `*` allows everyone. */
export function actorAllowed(actor: string, allowedActors: readonly string[]): boolean {
  return allowedActors.includes("*") || allowedActors.includes(actor);
}
