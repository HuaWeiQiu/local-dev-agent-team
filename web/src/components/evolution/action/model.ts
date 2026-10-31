import type { EvolutionProposal } from "../../../types";

/** The panel's decision, in the order the status machine resolves it. */
export type ActionKey =
  | "preflight"
  | "resume-preflight"
  | "review-ready"
  | "auto-comparing"
  | "preflight-failed"
  | "rollback"
  | "adopt"
  | "closed";

const STRUCTURAL = "server-structural-preflight-v1";
const AUTOMATIC = "server-automatic-run-evaluation-v1";

export function actionKey(proposal: EvolutionProposal): ActionKey {
  if (proposal.status === "proposed") return "preflight";
  if (proposal.status === "evaluating") return "resume-preflight";
  if (proposal.status !== "evaluated") return settledKey(proposal);
  return evaluatedKey(proposal);
}

function evaluatedKey(proposal: EvolutionProposal): ActionKey {
  const source = proposal.evaluation?.source;
  if (source === AUTOMATIC) return "auto-comparing";
  const passed = proposal.evaluation?.result.passed === true;
  return passed && source === STRUCTURAL ? "review-ready" : "preflight-failed";
}

function settledKey(proposal: EvolutionProposal): ActionKey {
  if (proposal.status !== "promoted") return "closed";
  return proposal.application?.rollbackSafe ? "rollback" : applicationState(proposal);
}

function applicationState(proposal: EvolutionProposal): ActionKey {
  return proposal.application ? "closed" : "adopt";
}

/** Archive is offered once the decision is final, and delete only after a reject. */
export function isReviewable(status: EvolutionProposal["status"]): boolean {
  return (
    status === "evaluated" ||
    status === "promoted" ||
    status === "rejected" ||
    status === "rolled-back"
  );
}

export function canDelete(proposal: EvolutionProposal): boolean {
  return proposal.status === "rejected";
}

export function failureTitle(proposal: EvolutionProposal): string {
  return proposal.evaluation?.source === "external" ? "需要当前结构预检" : "预检未通过";
}

export function failureDescription(proposal: EvolutionProposal): string {
  return proposal.evaluation?.result.summary ?? "候选没有可用于应用的服务端预检证据。";
}
