import { utf8ToBase64 } from "../../../evolution";
import type { PublicConfig } from "../../../types";
import type { EvolutionProposalInput } from "../../EvolutionProposalDialog";

export const MAX_PROMPT_BYTES = 262_144;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ProposalKind = "strategy" | "prompt";
export type Topology = "parallel-dag" | "sequential";

export interface Draft {
  kind: ProposalKind;
  sourceName: string;
  targetName: string;
  topology: Topology;
  maxParallel: number;
  maxReworkAttempts: number;
  role: string;
  content: string;
  commandId: string;
}

/** Sorted strategy names for the "based on" picker. */
export function strategyNamesOf(config: PublicConfig): string[] {
  return Object.keys(config.strategies.definitions).sort();
}

/** The draft a freshly opened dialog starts with. */
export function initialDraft(config: PublicConfig, promptRoles: Array<{ role: string }>): Draft {
  const base = config.strategies.default;
  const definition = definitionOf(config, base);
  return {
    kind: "strategy",
    sourceName: base,
    targetName: `${base}-evolved`,
    topology: definition?.topology?.mode ?? "parallel-dag",
    maxParallel: definition?.maxParallel ?? projectParallel(config),
    maxReworkAttempts: definition?.maxReworkAttempts ?? 2,
    role: promptRoles[0]?.role ?? "",
    content: "",
    commandId: crypto.randomUUID(),
  };
}

/** Re-seat the strategy fields when the operator picks another source. */
export function draftFromSource(config: PublicConfig, name: string): Pick<Draft, "sourceName" | "targetName" | "topology" | "maxParallel" | "maxReworkAttempts"> {
  const definition = definitionOf(config, name);
  return {
    sourceName: name,
    targetName: `${name}-evolved`,
    topology: definition?.topology?.mode ?? "parallel-dag",
    maxParallel: definition?.maxParallel ?? projectParallel(config),
    maxReworkAttempts: definition?.maxReworkAttempts ?? 2,
  };
}

/** A dialog can mount before the project config is complete; never throw for that. */
function definitionOf(config: PublicConfig, name: string) {
  return config.strategies?.definitions?.[name];
}

function projectParallel(config: PublicConfig): number {
  return config.project?.maxParallel ?? 2;
}

export function isValidTargetName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function areStrategyLimitsValid(maxParallel: number, maxReworkAttempts: number): boolean {
  const parallelOk = Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 32;
  const reworkOk =
    Number.isInteger(maxReworkAttempts) && maxReworkAttempts >= 0 && maxReworkAttempts <= 10;
  return parallelOk && reworkOk;
}

export function byteLengthOf(content: string): number {
  return new TextEncoder().encode(content).length;
}

/** Strategy drafts need a valid name, valid limits and a source that exists. */
export function canSubmitDraft(draft: Draft, config: PublicConfig): boolean {
  if (draft.kind === "prompt") {
    return Boolean(
      draft.role && draft.content.trim() && byteLengthOf(draft.content) <= MAX_PROMPT_BYTES,
    );
  }
  const sourceExists = Boolean(definitionOf(config, draft.sourceName));
  const limitsOk = areStrategyLimitsValid(draft.maxParallel, draft.maxReworkAttempts);
  return isValidTargetName(draft.targetName) && limitsOk && sourceExists;
}

/**
 * Turn a draft into the dialog's submit payload. Strategy drafts are cloned from
 * the chosen source, then the operator's topology and limits are applied.
 */
export function proposalFromDraft(draft: Draft, config: PublicConfig): EvolutionProposalInput | undefined {
  if (!canSubmitDraft(draft, config)) return undefined;
  if (draft.kind === "prompt") {
    return { kind: "prompt", role: draft.role, content: draft.content, commandId: draft.commandId };
  }
  const source = definitionOf(config, draft.sourceName);
  if (!source) return undefined;
  const definition = cloneDefinition(source);
  definition.topology = { mode: draft.topology };
  definition.maxParallel = draft.maxParallel;
  definition.maxReworkAttempts = draft.maxReworkAttempts;
  return {
    kind: "strategy",
    name: draft.targetName.trim(),
    definition,
    commandId: draft.commandId,
  };
}

function cloneDefinition(source: PublicConfig["strategies"]["definitions"][string]) {
  return JSON.parse(JSON.stringify(source)) as PublicConfig["strategies"]["definitions"][string];
}

/** Only used to keep the base64 helper reachable from one place in tests. */
export function encodePrompt(content: string): string {
  return utf8ToBase64(content);
}
