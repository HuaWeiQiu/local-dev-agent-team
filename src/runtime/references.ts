/**
 * Objects the model may need, named rather than pasted.
 *
 * A prompt that carries every Trigger, Ticket and Assignment in full spends its
 * window on things the current step does not need. The article that ADR 0020
 * follows treats context as a cache: give each object a stable id, inline the ids
 * that a step certainly needs, and let anything else be fetched when it is asked
 * for.
 *
 * This module is the smallest step of that: the shape of a reference, and one
 * stable way to render a list of them.
 */

export type ReferenceKind = "run" | "ticket" | "assignment" | "trigger" | "thread" | "task";

export interface ObjectRef {
  kind: ReferenceKind;
  /** Stable, unique, and never reused: the thing a follow-up would fetch. */
  id: string;
  /** One line a reader can act on. Never the object itself. */
  summary?: string;
}

/** The longest summary a reference carries; beyond it, the id is the answer. */
export const REFERENCE_SUMMARY_LIMIT = 120;

/** Render one reference as a single line: `kind/id` and, if there is one, why. */
export function renderReference(ref: ObjectRef): string {
  const summary = shortSummary(ref.summary);
  return summary ? `- ${ref.kind}/${ref.id}: ${summary}` : `- ${ref.kind}/${ref.id}`;
}

/**
 * Render a list for a prompt. Empty stays empty rather than becoming a heading
 * with nothing under it.
 */
export function renderReferences(refs: readonly ObjectRef[]): string {
  return refs.map(renderReference).join("\n");
}

/** A summary is a pointer, not a transcript: one line, bounded, never a paragraph. */
export function shortSummary(text: string | undefined): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= REFERENCE_SUMMARY_LIMIT) return oneLine;
  return `${oneLine.slice(0, REFERENCE_SUMMARY_LIMIT - 1)}…`;
}

/** Drop duplicates while keeping the order a caller chose. */
export function uniqueRefs(refs: readonly ObjectRef[]): ObjectRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}/${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The references one task attempt owes the model: what it is part of, and what it is. */
export function attemptReferences(input: {
  runId: string;
  goal: string;
  ticketId?: string | undefined;
  task: { id: string; title: string };
}): ObjectRef[] {
  return uniqueRefs([
    { kind: "run", id: input.runId, summary: input.goal },
    ...(input.ticketId
      ? [{ kind: "ticket" as const, id: input.ticketId, summary: "this run's authorized work" }]
      : []),
    { kind: "task", id: input.task.id, summary: input.task.title },
  ]);
}
