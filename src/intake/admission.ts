/**
 * From a webhook to the work it may start.
 *
 * This is the one place where the outside world can cause work, so the order is
 * the safety: read the event, drop what the Source must not act on, ask the gate
 * about what remains, and start a run only for an accept. A refusal starts
 * nothing at all — not a queued run, not a placeholder.
 *
 * The function decides and reports; the caller does the starting. That keeps
 * "what would have happened" answerable without starting anything, which is what
 * the tests rely on and what the panel will show.
 */

import { githubIntake, type DroppedEvent } from "./github-source.js";
import { makeTrigger, primaryThread, threadKey, type Trigger } from "./types.js";

export interface AdmissionRequest {
  event: string;
  payload: unknown;
  /** The logins this agent posts under; a comment that names one addresses it. */
  agentLogins: readonly string[];
  /** Event kinds this Source listens to; empty means the built-in set. */
  listened?: readonly string[];
  /**
   * The repository this Source is configured for. Without it the payload's own
   * repository is taken as the instance, and the "other repository" check can
   * never fire — which is why a real caller supplies it.
   */
  instanceId?: string;
}

/** One Trigger the Source accepted, and whether it addresses the agent. */
export interface Candidate {
  trigger: Trigger;
  addressed: boolean;
}

export interface AdmissionResult {
  candidates: Candidate[];
  dropped: DroppedEvent[];
}

/**
 * Read one webhook into the Triggers it carries and whether each addresses the
 * agent. Deciding is the caller's job: this only says what arrived and how to
 * read it, so the same reading can be replayed against a different policy.
 */
export function readAdmission(input: { request: AdmissionRequest }): AdmissionResult {
  const context = {
    instanceId: input.request.instanceId ?? repositoryOf(input.request.payload) ?? "unknown",
    selfLogins: input.request.agentLogins,
    ...(input.request.listened ? { listened: input.request.listened } : {}),
  };
  const intake = githubIntake(input.request.event, input.request.payload, context);
  const candidates: Candidate[] = [];
  for (const draft of intake.drafts) {
    const trigger = makeTrigger(draft);
    if (!trigger) continue;
    candidates.push({ trigger, addressed: addressesAgent(trigger, input.request.agentLogins) });
  }
  return { candidates, dropped: intake.dropped };
}

/** A comment that names one of the agent's logins is a request, not context. */
export function addressesAgent(trigger: Trigger, agentLogins: readonly string[]): boolean {
  if (agentLogins.length === 0) return false;
  const body = trigger.payload?.body;
  if (typeof body !== "string") return false;
  return agentLogins.some((login) => body.includes(`@${login}`));
}

/** The Thread an accepted Trigger would work on, as the gate and panel read it. */
export function admissionThread(trigger: Trigger): string | undefined {
  const thread = primaryThread(trigger);
  return thread ? threadKey(thread) : undefined;
}

function repositoryOf(payload: unknown): string | undefined {
  const name = asRecord(asRecord(payload)?.repository)?.full_name;
  return typeof name === "string" ? name : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
