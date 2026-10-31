/**
 * Granting a Mandate from an approval, and revalidating it before work resumes.
 *
 * A Mandate is written once, when a person approves a gate. Nothing rewrites it:
 * the only ways it stops applying are a person's explicit stop or a policy that
 * no longer holds it, and the second is answered by comparing against the
 * current policy rather than by mutating the record.
 */

import type { ApprovalResponse, RunState } from "../state/types.js";
import { mandateCovers, mandateRevocation, type Mandate, type PolicySnapshot, type Strength } from "./types.js";

/** Why a Mandate could not be granted or no longer applies. */
export class MandateError extends Error {
  constructor(
    readonly code:
      | "not-approved"
      | "no-scope"
      | "revoked"
      | "out-of-scope",
    message: string,
  ) {
    super(message);
    this.name = "MandateError";
  }
}

/** The paths an approved plan allows: every task's owned paths, de-duplicated. */
export function planScope(state: Pick<RunState, "tasks">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const task of state.tasks) {
    for (const path of task.task.ownedPaths) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * The Mandate an approval grants. An approval that is not an approval, or a plan
 * with no owned paths, grants nothing — work with no stated scope is exactly the
 * case a Mandate exists to prevent.
 */
export function grantMandate(input: {
  runId: string;
  approvalId: string;
  response: ApprovalResponse;
  policy: PolicySnapshot;
  scope: readonly string[];
  strength: Strength;
}): Mandate {
  if (input.response.decision !== "approved") {
    throw new MandateError("not-approved", `Approval '${input.approvalId}' was not approved`);
  }
  if (input.scope.length === 0) {
    throw new MandateError("no-scope", `Run '${input.runId}' approved with no owned paths`);
  }
  return {
    id: `${input.runId}:${input.approvalId}`,
    triggerId: input.runId,
    policyVersion: input.policy.version,
    scope: [...input.scope],
    strength: input.strength,
    actor: { sourceKind: "local-cli", id: input.response.actor },
    sourceKind: "local-cli",
    reliedOn: [...input.policy.rules],
    grantedAt: input.response.respondedAt,
  };
}

/** Refuse a resume or retry whose Mandate no longer holds under the current policy. */
export function assertMandateUsable(
  mandate: Mandate | undefined,
  policy: PolicySnapshot,
  action: "resume" | "retry",
): void {
  if (!mandate) {
    throw new MandateError(
      "revoked",
      `Cannot ${action}: this run has no recorded Mandate, so there is no authority to continue under`,
    );
  }
  const revocation = mandateRevocation(mandate, policy);
  if (revocation) {
    throw new MandateError(
      "revoked",
      `Cannot ${action}: the Mandate no longer holds (${revocation.code}: ${revocation.detail})`,
    );
  }
}

/** Refuse work outside the Mandate's scope: it needs a new Mandate, not a wider one. */
export function assertWithinScope(mandate: Mandate, paths: readonly string[]): void {
  const outside = paths.filter((path) => !mandateCovers(mandate, path));
  if (outside.length === 0) return;
  throw new MandateError(
    "out-of-scope",
    `Mandate '${mandate.id}' does not cover: ${outside.slice(0, 5).join(", ")}`,
  );
}

/**
 * A run needs a Mandate once a person approved a gate for it. Runs persisted
 * before Mandates existed, and runs that never asked for approval, continue as
 * they always did.
 */
export function needsMandate(state: Pick<RunState, "approvals">): boolean {
  return (state.approvals ?? []).some((entry) => entry.status === "approved");
}
