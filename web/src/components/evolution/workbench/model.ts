import { visibleEvolutionProposals, type EvolutionFilter } from "../../../evolution";
import type {
  EvolutionCompletedApplication,
  EvolutionProposal,
  EvolutionSnapshot,
} from "../../../types";

/** Wide enough for the two-pane rail; the server view picks the first proposal. */
export function isWideViewport(): boolean {
  return window.innerWidth > 800;
}

/**
 * Keep the current selection when it still exists, otherwise fall back to the
 * first proposal on a wide viewport (narrow panes stay on the rail).
 */
export function nextSelection(
  proposals: EvolutionProposal[],
  currentId: string | undefined,
  wide: boolean,
): string | undefined {
  if (currentId && proposals.some((item) => item.id === currentId)) return currentId;
  return wide ? proposals[0]?.id : undefined;
}

export function proposalsFor(
  snapshot: EvolutionSnapshot | undefined,
  filter: EvolutionFilter,
  query: string,
): EvolutionProposal[] {
  return visibleEvolutionProposals(snapshot?.proposals ?? [], filter, query);
}

export function selectedProposal(
  snapshot: EvolutionSnapshot | undefined,
  selectedId: string | undefined,
): EvolutionProposal | undefined {
  return snapshot?.proposals.find((proposal) => proposal.id === selectedId);
}

/** Every mutation is refused while recovery is pending or an operation is in flight. */
export function mutationLocked(snapshot: EvolutionSnapshot): boolean {
  return snapshot.recoveryRequired || snapshot.pendingOperation !== null;
}

export function auditFor(
  snapshot: EvolutionSnapshot,
  proposalId: string | undefined,
): EvolutionSnapshot["auditRecords"] {
  if (!proposalId) return [];
  return snapshot.auditRecords.filter((item) => item.proposalId === proposalId);
}

export function completedFor(
  snapshot: EvolutionSnapshot,
  proposalId: string | undefined,
): EvolutionCompletedApplication[] {
  if (!proposalId) return [];
  return snapshot.completedApplications.filter((item) => item.proposalId === proposalId);
}

export function lockReason(snapshot: EvolutionSnapshot): string {
  return snapshot.recoveryRequired
    ? "本地状态需要先恢复，所有变更操作均已停用。"
    : "已有目标变更正在处理，请等待完成后刷新。";
}

/** Automation is live while running or draining a stop request. */
export function automationActive(status: string | undefined): boolean {
  return status === "running" || status === "stopping";
}

export function clampCycles(configuredMaxCycles: number): number {
  return Math.min(3, configuredMaxCycles);
}
