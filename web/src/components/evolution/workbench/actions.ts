import {
  confirmEvolutionPromotion,
  confirmEvolutionRollback,
  deleteEvolutionProposal,
  evaluateEvolutionProposal,
  previewEvolutionPromotion,
  previewEvolutionRollback,
  proposeEvolutionPrompt,
  proposeEvolutionStrategy,
  reconcileEvolutionProposal,
  rejectEvolutionProposal,
  startAutomaticEvolution,
  stopAutomaticEvolution,
  archiveEvolutionProposal,
  unarchiveEvolutionProposal,
} from "../../../api";
import { utf8ToBase64 } from "../../../evolution";
import type { EvolutionPreviewResponse, EvolutionSnapshot, ProjectScope } from "../../../types";
import type { EvolutionDecision } from "../../EvolutionDecisionDialog";
import type { EvolutionProposalInput } from "../../EvolutionProposalDialog";

/** What a decision turns into once the reason is known. */
export interface DescribedDecision {
  mode: EvolutionDecision["mode"];
  proposalId: string;
  reason: string;
  expectedRevision?: number;
  token?: string;
}

/**
 * Turn a pending decision plus its reason into the exact arguments a command
 * needs. The preview-backed modes must still be inside their validity window.
 */
export function describeDecision(
  decision: EvolutionDecision,
  snapshot: EvolutionSnapshot,
  reason: string,
): DescribedDecision {
  const submittedReason = decision.submittedReason ?? reason;
  if (decision.mode === "promote" || decision.mode === "rollback") {
    return describedPreview(decision, submittedReason);
  }
  if (decision.mode === "adopt") {
    return {
      mode: "adopt",
      proposalId: decision.proposalId,
      reason: submittedReason,
      expectedRevision: snapshot.catalogRevision,
    };
  }
  return { mode: decision.mode, proposalId: decision.proposalId, reason: submittedReason };
}

function describedPreview(
  decision: EvolutionDecision,
  reason: string,
): DescribedDecision {
  const preview = decision.preview;
  if (!preview || Date.parse(preview.preview.expiresAt) <= Date.now()) {
    throw new Error("预览已经过期，请关闭后重新查看。");
  }
  return {
    mode: decision.mode,
    proposalId: decision.proposalId,
    reason,
    expectedRevision: preview.preview.catalogRevision,
    token: preview.preview.token,
  };
}

type DecisionHandler = (
  scope: ProjectScope,
  described: DescribedDecision,
  commandId: string,
) => Promise<unknown>;

const DECISION_HANDLERS: Record<EvolutionDecision["mode"], DecisionHandler> = {
  reject: (scope, described) =>
    rejectEvolutionProposal(scope, described.proposalId, described.reason),
  adopt: (scope, described, commandId) =>
    reconcileEvolutionProposal(
      scope,
      described.proposalId,
      { expectedRevision: described.expectedRevision!, reason: described.reason },
      commandId,
    ),
  delete: (scope, described, commandId) =>
    deleteEvolutionProposal(
      scope,
      described.proposalId,
      { reason: described.reason },
      commandId,
    ),
  promote: (scope, described, commandId) =>
    confirmEvolutionPromotion(scope, described.proposalId, confirmInput(described), commandId),
  rollback: (scope, described, commandId) =>
    confirmEvolutionRollback(scope, described.proposalId, confirmInput(described), commandId),
};

function confirmInput(described: DescribedDecision): {
  expectedRevision: number;
  token: string;
  reason: string;
} {
  return {
    expectedRevision: described.expectedRevision!,
    token: described.token!,
    reason: described.reason,
  };
}

export async function runDecision(
  scope: ProjectScope,
  described: DescribedDecision,
  commandId: string,
): Promise<void> {
  await DECISION_HANDLERS[described.mode](scope, described, commandId);
}

/** Create a candidate from the dialog payload and return its id. */
export async function submitProposal(
  scope: ProjectScope,
  input: EvolutionProposalInput,
): Promise<string> {
  const result =
    input.kind === "strategy"
      ? await proposeEvolutionStrategy(
          scope,
          { name: input.name, definition: input.definition },
          input.commandId,
        )
      : await proposeEvolutionPrompt(
          scope,
          { role: input.role, encoding: "base64", content: utf8ToBase64(input.content) },
          input.commandId,
        );
  return result.proposal.id;
}

export async function previewFor(
  scope: ProjectScope,
  mode: "promote" | "rollback",
  proposalId: string,
  catalogRevision: number,
): Promise<EvolutionPreviewResponse> {
  return mode === "promote"
    ? await previewEvolutionPromotion(scope, proposalId, catalogRevision)
    : await previewEvolutionRollback(scope, proposalId, catalogRevision);
}

export async function evaluate(scope: ProjectScope, proposalId: string): Promise<unknown> {
  return await evaluateEvolutionProposal(scope, proposalId);
}

export async function startAutomation(
  scope: ProjectScope,
  maxCycles: number,
  commandId: string,
): Promise<unknown> {
  return await startAutomaticEvolution(scope, maxCycles, commandId);
}

export async function stopAutomation(scope: ProjectScope): Promise<unknown> {
  return await stopAutomaticEvolution(scope);
}

export async function archive(scope: ProjectScope, proposalId: string, commandId: string) {
  return await archiveEvolutionProposal(scope, proposalId, {}, commandId);
}

export async function unarchive(scope: ProjectScope, proposalId: string, commandId: string) {
  return await unarchiveEvolutionProposal(scope, proposalId, {}, commandId);
}
