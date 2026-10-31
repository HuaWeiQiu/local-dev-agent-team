import type { PublicConfig, StrategyDefinition } from "../../../types";
import type { StrategyDraft } from "../draft";
import { topologyModeLabel } from "../draft";
import type { CompiledStrategyTopology } from "../../../types";

/** The selected definition, falling back to the project default. */
export function definitionFor(config: PublicConfig, name: string): StrategyDefinition {
  return config.strategies.definitions[name] ?? config.strategies.definitions[config.strategies.default]!;
}

export interface SummaryRow {
  label: string;
  value: string;
  on?: boolean;
}

/** The numbers pinned under the canvas. */
export function draftSummary(topology: CompiledStrategyTopology, draft: StrategyDraft): SummaryRow[] {
  const sequential = draft.mode === "sequential";
  return [
    { label: "阶段", value: String(topology.stages.length) },
    { label: "拓扑", value: topologyModeLabel(draft.mode) },
    { label: "并行上限", value: String(sequential ? 1 : draft.maxParallel) },
    {
      label: "Swarm 并发",
      value: String(sequential ? 1 : Math.min(draft.swarmMaxConcurrency, draft.maxParallel)),
    },
    { label: "探索", value: draft.exploreEnabled ? "已启用" : "未启用", on: draft.exploreEnabled },
    { label: "架构顾问", value: draft.advisorEnabled ? "已启用" : "未启用", on: draft.advisorEnabled },
    { label: "计划审批", value: draft.planApproval ? "已启用" : "未启用", on: draft.planApproval },
  ];
}

export type ComposerAction = "preflight" | "save" | "delete";

export interface ComposerFeedback {
  kind: "saved" | "valid" | "error";
  message: string;
}

/** What the toolbar says after each action. */
export function feedbackFor(
  action: Exclude<ComposerAction, "delete">,
): ComposerFeedback {
  return action === "save"
    ? { kind: "saved", message: "已保存并编译" }
    : { kind: "valid", message: "服务端预检通过" };
}

export const DELETE_FEEDBACK: ComposerFeedback = { kind: "saved", message: "蓝图已删除" };

export function errorFeedback(error: unknown): ComposerFeedback {
  return { kind: "error", message: error instanceof Error ? error.message : String(error) };
}
