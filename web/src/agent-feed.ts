import type { LiveAgent, RunEvent } from "./types";

export type FeedKind = "output" | "steer" | "interrupt" | "question" | "answer";

export interface FeedEntry {
  id: string;
  at: string;
  kind: FeedKind;
  text: string;
  actor?: string;
}

const OUTPUT_TAIL_CHARS = 4_000;
const INTERRUPTED_NOTE = "已中断，当前尝试结束";
const REDACTED_ANSWER = "（保密回答，未记录）";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** A payload that is known to be an object, so reads of it cannot throw. */
type Payload = Record<string, unknown>;

/** The one agent whose feed is being built. */
type FeedAgent = Pick<LiveAgent, "id" | "artifactKey">;

/** Output is addressed by artifact key; every other event by agent id. */
function isOutputEvent(type: string): boolean {
  return type === "agent.stdout" || type === "agent.stderr";
}

/** The chunk this event printed for `agent`, or undefined when it is not its output. */
function outputChunk(payload: Payload, agent: FeedAgent): string | undefined {
  if (payload.artifactKey !== agent.artifactKey) return undefined;
  return typeof payload.chunk === "string" ? payload.chunk : undefined;
}

/** Appends printed text, merging it into the previous entry while output is unbroken. */
function appendOutput(entries: FeedEntry[], event: RunEvent, chunk: string): void {
  const last = entries.at(-1);
  if (last?.kind === "output") {
    last.text += chunk;
    return;
  }
  entries.push({ id: `out-${event.sequence}`, at: event.occurredAt, kind: "output", text: chunk });
}

/** An operator interruption carries its own note, or the default one when silent. */
function interruptText(payload: Payload): string {
  return typeof payload.note === "string" ? payload.note : INTERRUPTED_NOTE;
}

/** A redacted answer is recorded as withheld; anything else is shown as given. */
function answerText(payload: Payload): string {
  return payload.redacted === true ? REDACTED_ANSWER : String(payload.answer ?? "");
}

/** One operator intervention: the entry kind it renders as, and the text it carries. */
interface InteractionRule {
  readonly kind: Exclude<FeedKind, "output">;
  readonly text: (payload: Payload) => string;
}

/** Event types that became part of the conversation, and how each one reads. */
const INTERACTION_RULES: Record<string, InteractionRule> = {
  "agent.steered": { kind: "steer", text: (payload) => String(payload.text ?? "") },
  "agent.interrupted": { kind: "interrupt", text: interruptText },
  "agent.question": { kind: "question", text: (payload) => String(payload.prompt ?? "") },
  "agent.answered": { kind: "answer", text: answerText },
};

/** Adds this event's printed text, if it printed any for `agent`. */
function appendOutputEvent(entries: FeedEntry[], event: RunEvent, payload: Payload, agent: FeedAgent): void {
  const chunk = outputChunk(payload, agent);
  if (chunk !== undefined) appendOutput(entries, event, chunk);
}

/** Adds this event as an operator intervention, if it is one addressed to `agent`. */
function appendInteraction(entries: FeedEntry[], event: RunEvent, payload: Payload, agent: FeedAgent): void {
  if (payload.agentId !== agent.id) return;
  const rule = INTERACTION_RULES[event.type];
  if (!rule) return;
  const actor = typeof payload.actor === "string" ? payload.actor : undefined;
  entries.push({
    id: `evt-${event.sequence}`,
    at: event.occurredAt,
    ...(actor ? { actor } : {}),
    kind: rule.kind,
    text: rule.text(payload),
  });
}

/** Turns one ledger event into at most one feed entry. */
function consumeEvent(entries: FeedEntry[], event: RunEvent, agent: FeedAgent): void {
  const payload = record(event.payload);
  if (!payload) return;
  if (isOutputEvent(event.type)) {
    appendOutputEvent(entries, event, payload, agent);
    return;
  }
  appendInteraction(entries, event, payload, agent);
}

/** Keeps only the tail of a runaway output, so one chatty agent cannot flood the panel. */
function trimOutputTail(entries: FeedEntry[]): FeedEntry[] {
  for (const entry of entries) {
    if (entry.kind === "output" && entry.text.length > OUTPUT_TAIL_CHARS) {
      entry.text = `…${entry.text.slice(-OUTPUT_TAIL_CHARS)}`;
    }
  }
  return entries;
}

/**
 * Builds one agent's conversation from the run ledger: what it printed, what
 * operators told it, and what it asked. Output is merged into single entries
 * and trimmed so a chatty agent cannot flood the panel.
 */
export function buildAgentFeed(events: RunEvent[], agent: Pick<LiveAgent, "id" | "artifactKey">): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const event of events) {
    consumeEvent(entries, event, agent);
  }
  return trimOutputTail(entries);
}

export function isLiveAgentEvent(type: string): boolean {
  return (
    type.startsWith("agent.session.")
    || type === "agent.question"
    || type === "agent.answered"
    || type === "agent.steered"
    || type === "agent.interrupted"
  );
}
