import { Bot, CircleAlert, CircleHelp, Terminal, UserRound, type LucideIcon } from "lucide-react";
import type { TranscriptEntry } from "../../types";

/** The kinds that get an icon and a body: a `turn` is a divider, so it is not in the table. */
export type MessageKind = Exclude<TranscriptEntry["kind"], "turn">;

export interface EntryStyle {
  /** The icon that opens the row. */
  icon: LucideIcon;
  /** That icon's colour. */
  iconClass: string;
  /** Tone of the label badge above the text. */
  labelTone: "active" | "neutral";
  /** Extra classes on the text block — tool output is monospace. */
  bodyClass: string;
}

/**
 * How each kind of transcript entry looks, in one table instead of the ternary
 * chain that used to sit inside `Entry`, the way `stage-stepper/tone.ts` does it.
 *
 * The kinds are exhaustive on purpose: a new entry kind should fail to compile
 * here rather than silently render as an ordinary message.
 */
export const entryStyles: Record<MessageKind, EntryStyle> = {
  message: { icon: Bot, iconClass: "text-muted", labelTone: "neutral", bodyClass: "" },
  tool: { icon: Terminal, iconClass: "text-muted", labelTone: "neutral", bodyClass: "font-mono text-2xs text-muted" },
  question: { icon: CircleHelp, iconClass: "text-muted", labelTone: "neutral", bodyClass: "" },
  notice: { icon: CircleAlert, iconClass: "text-muted", labelTone: "neutral", bodyClass: "" },
  operator: { icon: UserRound, iconClass: "text-accent", labelTone: "active", bodyClass: "" },
  output: { icon: Bot, iconClass: "text-muted", labelTone: "neutral", bodyClass: "" },
};
