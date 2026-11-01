/**
 * What goes into the prompt, and what waits outside it.
 *
 * The other half of ADR 0020's R4: naming an object keeps it out of the window,
 * and this keeps a *large* object out of it while leaving a way back in. A worker
 * prompt that starts with a 40k-character failure transcript spends its first
 * thousand tokens before it reaches the task.
 *
 * The rule is that nothing is thrown away silently: whatever is left out becomes a
 * reference saying how much there was and where to read it.
 */

import { shortSummary, type ObjectRef } from "./references.js";

/** The part of a long text that stays in the prompt. */
export interface Inline {
  head: string;
  /** Present only when something was left out. */
  spilled?: {
    chars: number;
    lines: number;
    /** Where the rest came from, and how to ask for it again. */
    ref: ObjectRef;
  };
}

export interface SpillInput {
  text: string;
  /** How much may stay inline. */
  maxChars: number;
  /** What this text is, so the reference points at something real. */
  ref: Pick<ObjectRef, "kind" | "id">;
}

/**
 * Keep the first `maxChars` of a text inline, and describe the rest.
 *
 * The cut never splits a surrogate pair: half an emoji in a prompt is worse than
 * one character fewer. It also prefers to end on a line boundary when one is close
 * to the cut, because a prompt that stops mid-word reads like a truncation bug.
 */
export function inlineWithin(input: SpillInput): Inline {
  const { text, maxChars } = input;
  if (text.length <= maxChars) return { head: text };
  const cut = safeCut(text, maxChars);
  const rest = text.slice(cut);
  return {
    head: text.slice(0, cut),
    spilled: {
      chars: rest.length,
      lines: rest.split("\n").length,
      ref: {
        kind: input.ref.kind,
        id: input.ref.id,
        summary: `truncated ${rest.length} chars, ${rest.split("\n").length} lines`,
      },
    },
  };
}

/** A cut point that does not split a surrogate pair, and prefers a line break. */
export function safeCut(text: string, maxChars: number): number {
  const limit = Math.max(0, Math.min(maxChars, text.length));
  const cut = limit > 0 && isLowSurrogate(text.charCodeAt(limit)) ? limit - 1 : limit;
  const lastBreak = text.lastIndexOf("\n", cut - 1);
  // Only honour a break that exists and is close to the cut; a much earlier one
  // wastes room, and `-1` is not a break at all.
  if (lastBreak >= 0 && lastBreak > cut - 200) return lastBreak;
  return cut;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The line a prompt carries about what was left out. */
export function spillNote(spilled: NonNullable<Inline["spilled"]>): string {
  return `(${shortSummary(spilled.ref.summary)} — read ${spilled.ref.kind}/${spilled.ref.id} for the rest)`;
}
