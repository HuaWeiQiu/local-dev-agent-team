import { agentRoleLabel, strategyDisplayName } from "./presentation";
import type {
  EvolutionLifecycleStatus,
  EvolutionProposal,
  EvolutionSnapshot,
  StrategyBlueprintDefinition,
  StrategyDefinition,
} from "./types";

export type EvolutionFilter = "open" | "all" | "archived" | EvolutionLifecycleStatus;

const statusOrder: Record<EvolutionLifecycleStatus, number> = {
  proposed: 0,
  evaluating: 1,
  evaluated: 2,
  promoted: 3,
  rejected: 4,
  "rolled-back": 5,
};

export const evolutionStatusLabels: Record<EvolutionLifecycleStatus, string> = {
  proposed: "待预检",
  evaluating: "预检中",
  evaluated: "待决定",
  promoted: "已应用",
  rejected: "已拒绝",
  "rolled-back": "已回滚",
};

export function evolutionStatusTone(status: EvolutionLifecycleStatus): string {
  if (status === "promoted") return "success";
  if (status === "rejected") return "danger";
  if (status === "evaluating") return "active";
  if (status === "rolled-back") return "neutral";
  return "warning";
}

function evaluatedStatusLabel(proposal: EvolutionProposal): string | undefined {
  if (proposal.status !== "evaluated" || !proposal.evaluation) return undefined;
  if (proposal.evaluation.source === "server-automatic-run-evaluation-v1") return "自动决策中";
  if (proposal.evaluation.source === "external") return "需当前预检";
  return proposal.evaluation.result.passed ? undefined : "预检未通过";
}

export function proposalStatusLabel(proposal: EvolutionProposal): string {
  const evaluated = evaluatedStatusLabel(proposal);
  if (evaluated !== undefined) return evaluated;
  return proposal.status === "promoted" && !proposal.application
    ? "待登记"
    : evolutionStatusLabels[proposal.status];
}

export function proposalStatusTone(proposal: EvolutionProposal): string {
  if (
    proposal.status === "evaluated" &&
    proposal.evaluation?.source === "server-automatic-run-evaluation-v1"
  ) {
    return "active";
  }
  if (proposal.status === "evaluated" && proposal.evaluation && !proposal.evaluation.result.passed) {
    return "danger";
  }
  return proposal.status === "promoted" && !proposal.application
    ? "warning"
    : evolutionStatusTone(proposal.status);
}

export function proposalProgress(proposal: EvolutionProposal): {
  step: 1 | 2 | 3 | 4;
  finalLabel: string;
} {
  if (proposal.status === "proposed") return { step: 1, finalLabel: "已应用" };
  if (proposal.status === "evaluating" || proposal.status === "evaluated") {
    return { step: 2, finalLabel: "已应用" };
  }
  if (proposal.status === "promoted" && !proposal.application) {
    return { step: 3, finalLabel: "待登记" };
  }
  return {
    step: 4,
    finalLabel: proposal.status === "rejected"
      ? "已拒绝"
      : proposal.status === "rolled-back" ? "已回滚" : "已应用",
  };
}

export function proposalTitle(proposal: EvolutionProposal): string {
  if (proposal.candidate.kind === "strategy-blueprint") {
    return strategyDisplayName(proposal.candidate.name);
  }
  const file = proposal.candidate.path.split("/").at(-1) ?? proposal.candidate.path;
  const role = file.replace(/\.[^.]+$/, "");
  return agentRoleLabel(role);
}

export function proposalTarget(proposal: EvolutionProposal): string {
  if (proposal.candidate.kind === "strategy-blueprint") {
    return `策略 · ${strategyDisplayName(proposal.candidate.name)}`;
  }
  const file = proposal.candidate.path.split("/").at(-1) ?? proposal.candidate.path;
  const role = file.replace(/\.[^.]+$/, "");
  return `提示词 · ${agentRoleLabel(role)}`;
}

function inArchivedView(
  proposal: EvolutionProposal,
  filter: EvolutionFilter,
): boolean {
  // 归档候选只出现在「已归档」视图；其余视图一律排除
  return filter === "archived"
    ? proposal.archivedAt !== undefined
    : proposal.archivedAt === undefined;
}

function stillOpen(proposal: EvolutionProposal): boolean {
  if (proposal.status === "rejected" || proposal.status === "rolled-back") return false;
  return !(proposal.status === "promoted" && proposal.application !== null);
}

function matchesStatusFilter(
  proposal: EvolutionProposal,
  filter: EvolutionFilter,
): boolean {
  if (filter === "open") return stillOpen(proposal);
  if (filter === "all" || filter === "archived") return true;
  return proposal.status === filter;
}

function matchesQuery(proposal: EvolutionProposal, normalized: string): boolean {
  if (!normalized) return true;
  return `${proposal.id} ${proposalTitle(proposal)} ${proposalTarget(proposal)}`
    .toLocaleLowerCase("zh-CN")
    .includes(normalized);
}

function compareProposals(left: EvolutionProposal, right: EvolutionProposal): number {
  const status = statusOrder[left.status] - statusOrder[right.status];
  if (status !== 0) return status;
  const created = right.createdAt.localeCompare(left.createdAt);
  return created !== 0 ? created : left.id.localeCompare(right.id);
}

export function visibleEvolutionProposals(
  proposals: readonly EvolutionProposal[],
  filter: EvolutionFilter,
  query: string,
): EvolutionProposal[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return proposals
    .filter(
      (proposal) =>
        inArchivedView(proposal, filter) &&
        matchesStatusFilter(proposal, filter) &&
        matchesQuery(proposal, normalized),
    )
    .sort(compareProposals);
}

export function evolutionLocked(snapshot: EvolutionSnapshot): boolean {
  return snapshot.recoveryRequired
    || snapshot.pendingOperation !== null
    || snapshot.automation.status === "running"
    || snapshot.automation.status === "stopping";
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function toBlueprintDefinition(definition: StrategyDefinition): StrategyBlueprintDefinition {
  const {
    compiledTopology: _compiledTopology,
    source: _source,
    ...blueprint
  } = definition;
  return structuredClone(blueprint);
}
