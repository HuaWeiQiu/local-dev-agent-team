import type { ComposerFeedback } from "./model";

export type PillState = "submitting" | "failed" | "reported" | "dirty" | "clean";

export const PILL_TEXT: Record<Exclude<PillState, "reported">, string> = {
  submitting: "提交中",
  failed: "操作失败",
  dirty: "草稿待预检",
  clean: "已加载策略",
};

export const PILL_TONE: Record<PillState, "danger" | "success" | "warning" | "neutral"> = {
  submitting: "neutral",
  failed: "danger",
  reported: "success",
  dirty: "warning",
  clean: "neutral",
};

/** Submitting wins over an old result; a reported result wins over dirtiness. */
export function pillState(input: {
  feedback: ComposerFeedback | undefined;
  dirty: boolean;
  submitting: boolean;
}): PillState {
  if (input.submitting) return "submitting";
  if (input.feedback?.kind === "error") return "failed";
  if (input.feedback) return "reported";
  return input.dirty ? "dirty" : "clean";
}

export function pillText(state: PillState, feedback: ComposerFeedback | undefined): string {
  if (state === "reported") return feedback?.message ?? PILL_TEXT.clean;
  return PILL_TEXT[state];
}
