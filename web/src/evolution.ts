import { agentRoleLabel, strategyDisplayName } from "./presentation";
import type {
  EvolutionLifecycleStatus,
  EvolutionProposal,
  EvolutionSnapshot,
  StrategyBlueprintDefinition,
  StrategyDefinition,
} from "./types";

export type EvolutionFilter = "open" | "all" | EvolutionLifecycleStatus;

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

export function proposalStatusLabel(proposal: EvolutionProposal): string {
  if (proposal.status === "evaluated") {
    if (proposal.evaluation?.source === "server-automatic-run-evaluation-v1") {
      return "自动决策中";
    }
    if (proposal.evaluation?.source === "external") return "需当前预检";
    if (proposal.evaluation && !proposal.evaluation.result.passed) return "预检未通过";
  }
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

export function visibleEvolutionProposals(
  proposals: readonly EvolutionProposal[],
  filter: EvolutionFilter,
  query: string,
): EvolutionProposal[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return proposals
    .filter((proposal) => {
      if (filter === "open" && (
        ["rejected", "rolled-back"].includes(proposal.status)
        || (proposal.status === "promoted" && proposal.application !== null)
      )) {
        return false;
      }
      if (filter !== "open" && filter !== "all" && proposal.status !== filter) return false;
      if (!normalized) return true;
      return `${proposal.id} ${proposalTitle(proposal)} ${proposalTarget(proposal)}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized);
    })
    .sort((left, right) => {
      const status = statusOrder[left.status] - statusOrder[right.status];
      return status || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
    });
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
