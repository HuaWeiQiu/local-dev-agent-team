import type { StageState } from "../../stages";

/**
 * How each stage state looks, in one table instead of five conditionals spread
 * across the icon, its colour, the label and the connector.
 *
 * The states are exhaustive on purpose: a new state should fail to compile here
 * rather than silently render as "pending".
 */
export interface StageTone {
  /** The dot that carries the state. */
  dot: string;
  /** The label beside it. */
  text: string;
  /** The connector to the next stage. */
  connector: string;
  /** What a screen reader says after the label. */
  spoken: string;
}

const TONES: Record<StageState, StageTone> = {
  done: {
    dot: "bg-success",
    text: "text-ink-2",
    connector: "bg-success/50",
    spoken: "（已完成）",
  },
  current: {
    dot: "bg-accent",
    text: "text-ink",
    connector: "bg-line-strong",
    spoken: "（进行中）",
  },
  failed: {
    dot: "bg-danger",
    text: "text-danger-ink",
    connector: "bg-line-strong",
    spoken: "（在此停止）",
  },
  skipped: {
    dot: "bg-surface-3 text-muted",
    text: "text-muted",
    connector: "bg-success/50",
    spoken: "（已跳过）",
  },
  pending: {
    dot: "bg-surface-3 text-muted",
    text: "text-muted",
    connector: "bg-line-strong",
    spoken: "（未开始）",
  },
};

export function stageTone(state: StageState): StageTone {
  return TONES[state] ?? TONES.pending;
}

/** Which states count as already behind us, for the connector colour. */
export function isBehind(state: StageState): boolean {
  return state === "done" || state === "skipped";
}
