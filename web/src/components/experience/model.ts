import type { AutomaticEvolutionSnapshot, ExperienceScope, ExperienceStatus } from "../../types";
import type { BadgeProps } from "../../ui/badge";

export type ExperienceFilter = "all" | ExperienceStatus | "shared" | "project";
export type ActionMode = "promote" | "reject" | "share" | "retire";
export type LatestEvaluation = NonNullable<AutomaticEvolutionSnapshot["lastEvaluation"]>;
export type BadgeTone = NonNullable<BadgeProps["tone"]>;

export const statusLabels: Record<ExperienceStatus, string> = {
  candidate: "候选",
  verified: "已验证",
  rejected: "已拒绝",
  retired: "已退役",
};

export const statusTone: Record<ExperienceStatus, BadgeTone> = {
  candidate: "warning",
  verified: "success",
  rejected: "danger",
  retired: "neutral",
};

export const filterOptions: ReadonlyArray<{ value: ExperienceFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "candidate", label: "候选" },
  { value: "verified", label: "已验证" },
  { value: "shared", label: "公共" },
  { value: "project", label: "本项目" },
  { value: "rejected", label: "已拒绝" },
  { value: "retired", label: "已退役" },
];

export const actionTitles: Record<ActionMode, string> = {
  promote: "晋升为已验证",
  share: "写入公共库",
  retire: "退役（不再注入规划）",
  reject: "拒绝",
};

export const actionDescriptions: Record<ActionMode, string> = {
  promote: "晋升后，这条经验会在后续规划中注入。",
  share: "写入公共库后，其他项目也能检索到它。",
  retire: "退役的经验保留在目录中供审计，不再参与规划。",
  reject: "拒绝后，这条经验不会进入规划。",
};

export function scopeLabel(scope: ExperienceScope): string {
  return scope === "shared" ? "公共" : "项目";
}

export function shortPath(value: string): string {
  if (value.length <= 48) return value;
  return `…${value.slice(-44)}`;
}
