import { humanizeFailure, strategyDisplayName, summarizeGoal } from "../../presentation";
import type { BoardCard, BoardLane } from "../../board";

export type RailTone = "danger" | "warning" | "accent" | "success";

/** The left rail encodes the lane, except that a blocked run in the
 *  attention lane is worse than a merely gated one. */
export const RAIL_CLASS: Record<RailTone, string> = {
  danger: "border-l-danger",
  warning: "border-l-warning",
  accent: "border-l-accent",
  success: "border-l-success",
};

export function railClass(card: BoardCard): string {
  return RAIL_CLASS[railTone(card, card.lane)];
}

const LANE_RAIL: Record<BoardLane, RailTone> = {
  attention: "warning",
  active: "accent",
  done: "success",
};

export function railTone(card: BoardCard, lane: BoardLane): RailTone {
  const blocked = lane === "attention" && card.reason?.tone === "danger";
  return blocked ? "danger" : LANE_RAIL[lane];
}

export function progressPercent(card: BoardCard): number {
  const { done, total } = card.progress;
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

export function barTone(card: BoardCard): "danger" | "accent" {
  return railClass(card) === RAIL_CLASS.danger ? "danger" : "accent";
}

export function goalLabel(goal: string, max = 90): string {
  return summarizeGoal(goal, max);
}

export function strategyLabel(card: BoardCard): string {
  return strategyDisplayName(card.run.strategy);
}

/** Failures are only interesting when the run is not still working. */
export function visibleFailure(card: BoardCard): string | undefined {
  if (card.lane === "active") return undefined;
  return humanizeFailure(card.run.error) || undefined;
}

export function badgeFor(card: BoardCard): { label: string; tone: string } | undefined {
  if (!card.reason) return undefined;
  return { label: card.reason.label, tone: card.reason.tone };
}
