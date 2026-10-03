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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Builds one agent's conversation from the run ledger: what it printed, what
 * operators told it, and what it asked. Output is merged into single entries
 * and trimmed so a chatty agent cannot flood the panel.
 */
export function buildAgentFeed(events: RunEvent[], agent: Pick<LiveAgent, "id" | "artifactKey">): FeedEntry[] {
  const entries: FeedEntry[] = [];
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (event.type === "agent.stdout" || event.type === "agent.stderr") {
      if (payload.artifactKey !== agent.artifactKey || typeof payload.chunk !== "string") continue;
      const last = entries.at(-1);
      if (last?.kind === "output") {
        last.text += payload.chunk;
      } else {
        entries.push({ id: `out-${event.sequence}`, at: event.occurredAt, kind: "output", text: payload.chunk });
      }
      continue;
    }
    if (payload.agentId !== agent.id) continue;
    const actor = typeof payload.actor === "string" ? payload.actor : undefined;
    const base = { id: `evt-${event.sequence}`, at: event.occurredAt, ...(actor ? { actor } : {}) };
    switch (event.type) {
      case "agent.steered":
        entries.push({ ...base, kind: "steer", text: String(payload.text ?? "") });
        break;
      case "agent.interrupted":
        entries.push({
          ...base,
          kind: "interrupt",
          text: typeof payload.note === "string" ? payload.note : "已中断，当前尝试结束",
        });
        break;
      case "agent.question":
        entries.push({ ...base, kind: "question", text: String(payload.prompt ?? "") });
        break;
      case "agent.answered":
        entries.push({
          ...base,
          kind: "answer",
          text: payload.redacted === true ? "（保密回答，未记录）" : String(payload.answer ?? ""),
        });
        break;
      default:
    }
  }
  for (const entry of entries) {
    if (entry.kind === "output" && entry.text.length > OUTPUT_TAIL_CHARS) {
      entry.text = `…${entry.text.slice(-OUTPUT_TAIL_CHARS)}`;
    }
  }
  return entries;
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
