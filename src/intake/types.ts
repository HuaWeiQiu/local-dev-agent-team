/**
 * The intake vocabulary: where work comes from.
 *
 * A Source is a stream of events. It keeps its own read position, drops its own
 * messages and anything outside what it listens to, and translates each event
 * into one immutable Trigger and the Threads that Trigger belongs to.
 *
 * Nothing here performs I/O; the pure functions are what a Source implementation
 * calls, so their rules can be tested without a network or a clock.
 */

export type SourceKind = "github" | "local-cli" | "ci" | (string & {});

/** How a Trigger asks for something. */
export type TriggerKind =
  | "request"
  | "comment"
  | "review"
  | "ci-change"
  | "close"
  | "policy-change"
  | (string & {});

/**
 * A Thread is one conversation a Source recognises: a pull request, an issue, a
 * local session. Triggers on the same Thread are evaluated together, one Eval at
 * a time.
 */
export interface ThreadRef {
  sourceKind: SourceKind;
  /** Identifies the Source instance, so two GitHub repos stay apart. */
  sourceInstanceId: string;
  /** The conversation inside that instance: `pull/123`, `issue/7`, `session/abc`. */
  threadId: string;
}

/** The actor, exactly as the Source names it. Never mapped across Sources. */
export interface ActorRef {
  sourceKind: SourceKind;
  /** A login, an email, a local user name — whatever the Source reports. */
  id: string;
}

export interface Trigger {
  /** Stable identity; see `triggerIdentity`. */
  id: string;
  sourceKind: SourceKind;
  sourceInstanceId: string;
  /** The Source's own id for the event, used for idempotence. */
  externalId: string;
  kind: TriggerKind;
  /** The Threads this Trigger belongs to; the first one is primary. */
  threads: readonly ThreadRef[];
  actor: ActorRef;
  /** ISO timestamp the Source reported (or its receipt time, never a guess). */
  at: string;
  /** Source-specific metadata; opaque above the Source. */
  payload?: Readonly<Record<string, unknown>>;
}

/** What a Source must be able to answer before it may emit a Trigger. */
export interface TriggerDraft {
  sourceKind: SourceKind;
  sourceInstanceId: string;
  externalId: string;
  kind: TriggerKind;
  threads: readonly ThreadRef[];
  actor: ActorRef;
  at: string;
  payload?: Readonly<Record<string, unknown>>;
}

/**
 * The idempotence key: one external event yields one Trigger, however many times
 * the Source delivers it. Accepting the same Trigger twice creates one Ticket.
 */
export function triggerIdentity(input: {
  sourceKind: SourceKind;
  sourceInstanceId: string;
  externalId: string;
}): string {
  return [input.sourceKind, input.sourceInstanceId, input.externalId]
    .map((part) => part.trim())
    .join("\u0000");
}

/** A draft becomes a Trigger only when it names at least one Thread. */
export function makeTrigger(draft: TriggerDraft): Trigger | undefined {
  if (!draft.sourceInstanceId.trim() || !draft.externalId.trim()) return undefined;
  if (draft.threads.length === 0) return undefined;
  return {
    id: triggerIdentity(draft),
    sourceKind: draft.sourceKind,
    sourceInstanceId: draft.sourceInstanceId,
    externalId: draft.externalId,
    kind: draft.kind,
    threads: [...draft.threads],
    actor: draft.actor,
    at: draft.at,
    ...(draft.payload ? { payload: draft.payload } : {}),
  };
}

export function threadKey(thread: ThreadRef): string {
  return [thread.sourceKind, thread.sourceInstanceId, thread.threadId].join("\u0000");
}

/** The Thread an Eval runs on: the first one the Trigger names. */
export function primaryThread(trigger: Trigger): ThreadRef | undefined {
  return trigger.threads[0];
}

/** Every Thread of the Trigger, once each, primary first. */
export function uniqueThreads(trigger: Trigger): ThreadRef[] {
  const seen = new Set<string>();
  const out: ThreadRef[] = [];
  for (const thread of trigger.threads) {
    const key = threadKey(thread);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(thread);
  }
  return out;
}

/** Whether two Triggers share a Thread (they are then correlated). */
export function sharesThread(left: Trigger, right: Trigger): boolean {
  const keys = new Set(uniqueThreads(left).map(threadKey));
  return uniqueThreads(right).some((thread) => keys.has(threadKey(thread)));
}
