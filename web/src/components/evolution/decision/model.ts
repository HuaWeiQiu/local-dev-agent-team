import type { EvolutionPreviewResponse } from "../../../types";
import type { EvolutionDecision } from "../../EvolutionDecisionDialog";

export interface DecisionCopy {
  description: string;
  title: string;
  action: string;
}

const COPY: Record<EvolutionDecision["mode"], DecisionCopy> = {
  promote: { description: "人工确认 · 仅对本次修订和当前目标有效。", title: "确认应用候选", action: "确认应用" },
  rollback: { description: "回滚 · 将目标恢复为应用前的精确内容。", title: "确认回滚目标", action: "确认回滚" },
  reject: { description: "人工决定 · 候选将保留为只读审计记录。", title: "拒绝候选", action: "确认拒绝" },
  adopt: { description: "遗留恢复 · 登记已存在的目标内容。", title: "采纳当前目标", action: "确认采纳" },
  delete: { description: "危险操作 · 删除后无法恢复。", title: "删除候选", action: "确认删除" },
};

export function copyFor(decision: EvolutionDecision | undefined): DecisionCopy {
  return COPY[decision?.mode ?? "promote"];
}

/** Reject and delete are destructive: the submit button turns red. */
export function isDestructive(mode: EvolutionDecision["mode"] | undefined): boolean {
  return mode === "reject" || mode === "delete";
}

/** Modal width: the preview needs two panes, the reason-only dialogs do not. */
export function dialogWidth(preview: EvolutionPreviewResponse | undefined): string {
  return preview ? "w-[min(960px,calc(100vw-32px))] text-sm" : "w-[min(540px,calc(100vw-32px))] text-sm";
}

/** Footer label: a retry after a submitted reason reads differently. */
export function actionLabel(decision: EvolutionDecision | undefined, busy: boolean): string {
  if (busy) return "提交中";
  if (decision?.submittedReason !== undefined) return "重试原确认";
  return copyFor(decision).action;
}

export function submitDisabled(decision: EvolutionDecision | undefined, busy: boolean, reason: string): boolean {
  return busy || !reason.trim() || decision === undefined;
}

/** A reason is required; the caller trims it. */
export function trimmedReason(reason: string): string | undefined {
  const trimmed = reason.trim();
  return trimmed ? trimmed : undefined;
}
