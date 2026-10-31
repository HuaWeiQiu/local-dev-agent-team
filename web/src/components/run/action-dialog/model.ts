import { planCompletenessForRun } from "../../../plan-completeness";
import type { ApprovalRequest, RunState } from "../../../types";
import type { EditablePlan } from "../../PlanEditor";
import { planDraftProblem } from "../../PlanEditor";

export type DialogMode = "approval" | "resume" | "pause" | undefined;

export type SubmitInput = {
  decision?: "approved" | "rejected";
  actor: string;
  reason: string;
  plan?: EditablePlan;
};

/** The dialog's title for each mode. */
export function dialogTitle(mode: DialogMode, approval?: ApprovalRequest): string {
  if (mode === "approval") return approval?.gate === "plan" ? "审批执行计划" : "审批交付结果";
  return mode === "pause" ? "暂停运行" : "恢复运行";
}

export function dialogDescription(mode: DialogMode): string {
  if (mode === "approval") return "人工门禁：记录操作者与理由后生效。";
  return mode === "pause" ? "暂停后可随时从检查点恢复。" : "从最近的检查点继续执行。";
}

export function submitLabel(mode: DialogMode, edited: boolean, busy: boolean): string {
  if (busy) return "提交中";
  if (mode !== "approval") return mode === "pause" ? "暂停" : "恢复";
  return edited ? "批准修改后的计划" : "批准";
}

/** Only a plan gate on a run that has a plan can be edited here. */
export function canEditPlan(mode: DialogMode, approval?: ApprovalRequest, run?: RunState): boolean {
  return mode === "approval" && approval?.gate === "plan" && Boolean(run?.plan);
}

export function hasEdits(
  editing: boolean,
  draft: EditablePlan | undefined,
  run?: RunState,
): boolean {
  if (!editing || draft === undefined) return false;
  return JSON.stringify(draft) !== JSON.stringify(run?.plan);
}

export function draftProblemOf(edited: boolean, draft?: EditablePlan): string | undefined {
  return edited && draft ? planDraftProblem(draft) : undefined;
}

export function completenessOf(mode: DialogMode, approval?: ApprovalRequest, run?: RunState) {
  if (!mode || !run || approval?.gate !== "plan") return undefined;
  return planCompletenessForRun(run);
}

/** An incomplete plan needs an explicit acknowledgement unless it was edited. */
export function approveBlockedBy(
  completeness: ReturnType<typeof completenessOf>,
  acknowledged: boolean,
  edited: boolean,
): boolean {
  if (!completeness) return false;
  const incomplete = completeness.status !== "complete";
  return (incomplete && !acknowledged && !edited) || false;
}

export function isIncomplete(completeness: ReturnType<typeof completenessOf>): boolean {
  return completeness !== undefined && completeness.status !== "complete";
}

/** The payload the dialog hands back, omitting what the mode does not send. */
export function submitPayload(input: {
  decision?: "approved" | "rejected";
  actor: string;
  reason: string;
  plan?: EditablePlan;
}): SubmitInput | undefined {
  const actor = input.actor.trim();
  const reason = input.reason.trim();
  if (!actor || !reason) return undefined;
  return {
    ...(input.decision ? { decision: input.decision } : {}),
    actor,
    reason,
    ...(input.plan ? { plan: input.plan } : {}),
  };
}

export type DialogView = {
  editable: boolean;
  edited: boolean;
  draftProblem: string | undefined;
  completeness: ReturnType<typeof completenessOf>;
  approveBlocked: boolean;
  ready: boolean;
};

/** Everything the dialog derives from its inputs and local state. */
export function dialogView(input: {
  mode: DialogMode;
  approval?: ApprovalRequest;
  run?: RunState;
  draft?: EditablePlan;
  editing: boolean;
  acknowledged: boolean;
  actor: string;
  reason: string;
}): DialogView {
  const edited = hasEdits(input.editing, input.draft, input.run);
  const draftProblem = draftProblemOf(edited, input.draft);
  const completeness = completenessOf(input.mode, input.approval, input.run);
  const blocked = approveBlockedBy(completeness, input.acknowledged, edited);
  return {
    editable: canEditPlan(input.mode, input.approval, input.run),
    edited,
    draftProblem,
    completeness,
    approveBlocked: blocked || draftProblem !== undefined,
    ready: Boolean(input.actor.trim() && input.reason.trim()),
  };
}
