import { createHash } from "node:crypto";
import type { LoadedConfig } from "../config/load.js";
import {
  type ApplicationCommandResult,
  type ApplicationPreview,
  type ApplicationPreviewDescription,
  EvolutionApplicationCoordinator,
} from "../evolution/application.js";
import {
  EVOLUTION_DOMAIN_VERSION,
  type EvolutionCandidate,
  type EvolutionPolicy,
  type EvolutionProposal,
} from "../evolution/domain.js";
import type { NamedStrategy } from "../config/schema.js";
import type { RunSupervisor } from "./supervisor.js";

export const EVOLUTION_EVIDENCE_SCOPE =
  "server-structural-preflight-not-candidate-execution" as const;

export type EvolutionServiceErrorCode =
  | "COMMAND_CONFLICT"
  | "PROMPT_ROLE_NOT_FOUND"
  | "PROPOSAL_NOT_FOUND"
  | "SERVICE_CLOSED";

export class EvolutionServiceError extends Error {
  constructor(
    readonly code: EvolutionServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvolutionServiceError";
  }
}

export class EvolutionProjectService {
  private sealed = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  private targetMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly loaded: LoadedConfig,
    readonly coordinator: EvolutionApplicationCoordinator,
    readonly supervisor: RunSupervisor,
  ) {}

  async close(): Promise<void> {
    this.sealed = true;
    const results = await Promise.allSettled([...this.inFlight]);
    const errors: unknown[] = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    try {
      await this.coordinator.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Evolution operations failed while closing");
    }
  }

  async snapshot(): Promise<unknown> {
    return await this.perform(async () => {
      const control = await this.coordinator.readControlSnapshot();
      const applicationByProposal = new Map(
        control.application.applications.map((record) => [record.proposalId, record]),
      );
      return {
        catalogRevision: control.catalogRevision,
        applicationRevision: control.application.revision,
        recoveryRequired: control.application.recoveryRequired,
        promptRoles: Object.entries(this.loaded.config.roles)
          .filter((entry): entry is [string, (typeof entry)[1] & { promptFile: string }] =>
            typeof entry[1].promptFile === "string",
          )
          .map(([role, policy]) => ({ role, path: policy.promptFile }))
          .sort((left, right) => left.role.localeCompare(right.role)),
        proposals: control.catalog.proposals.map((proposal) => ({
          ...proposal,
          application: sanitizeApplication(applicationByProposal.get(proposal.id)),
        })),
        activeProposals: control.catalog.activeProposals,
        auditRecords: control.catalog.auditRecords,
        completedApplications: control.application.completed.map((record) => ({
          operation: record.operation,
          proposalId: record.proposalId,
          status: record.status,
          beforeTargetDigest: record.beforeTargetDigest,
          afterTargetDigest: record.afterTargetDigest,
          catalogRevisionBefore: record.catalogRevisionBefore,
          catalogRevisionAfter: record.catalogRevisionAfter,
          operator: record.operator,
          reason: record.reason,
          completedAt: record.completedAt,
        })),
        pendingOperation: control.application.pending
          ? {
              operation: control.application.pending.operation,
              proposalId: control.application.pending.proposalId,
              startedAt: control.application.pending.startedAt,
            }
          : null,
        evidenceScope: EVOLUTION_EVIDENCE_SCOPE,
      };
    });
  }

  async proposeStrategy(
    idempotencyKey: string,
    input: { name: string; definition: NamedStrategy },
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number; deduplicated: boolean }> {
    return await this.perform(async () =>
      await this.proposeBound(
        idempotencyKey,
        { kind: "strategy-blueprint", name: input.name, definition: input.definition },
        policyFor([]),
      ),
    );
  }

  async proposePrompt(
    idempotencyKey: string,
    input: { role: string; content: Uint8Array },
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number; deduplicated: boolean }> {
    return await this.perform(async () => {
      const role = this.loaded.config.roles[input.role];
      if (!role?.promptFile) {
        throw new EvolutionServiceError(
          "PROMPT_ROLE_NOT_FOUND",
          `Role '${input.role}' does not have a configured prompt file`,
        );
      }
      const candidate: EvolutionCandidate = {
        kind: "role-prompt",
        path: role.promptFile,
        contentDigest: createHash("sha256").update(input.content).digest("hex"),
      };
      return await this.proposeBound(
        idempotencyKey,
        candidate,
        policyFor([role.promptFile]),
        input.content,
      );
    });
  }

  async evaluate(proposalId: string): Promise<unknown> {
    return await this.perform(async () =>
      await this.coordinator.evaluateServerPreflight(proposalId),
    );
  }

  async reject(proposalId: string, operator: string, reason: string): Promise<unknown> {
    return await this.perform(async () =>
      await this.coordinator.reject(proposalId, { operator, reason }),
    );
  }

  async previewPromotion(
    proposalId: string,
    operator: string,
    expectedRevision: number,
  ): Promise<{
    preview: ApplicationPreview;
    description: ApplicationPreviewDescription;
    evidenceScope: typeof EVOLUTION_EVIDENCE_SCOPE;
  }> {
    return await this.perform(async () => {
      await this.coordinator.assertServerPreflightEvaluation(proposalId);
      const preview = await this.coordinator.previewPromotion({
        proposalId,
        operator,
        expectedRevision,
      });
      const description = await this.coordinator.describePreview({
        token: preview.token,
        kind: "promote-and-apply",
        proposalId,
        operator,
        expectedRevision,
      });
      return { preview, description, evidenceScope: EVOLUTION_EVIDENCE_SCOPE };
    });
  }

  async promote(input: {
    commandId: string;
    proposalId: string;
    operator: string;
    reason: string;
    expectedRevision: number;
    token: string;
  }): Promise<ApplicationCommandResult> {
    return await this.perform(async () => {
      const replay = await this.coordinator.replayCommand({
        ...input,
        operation: "promote-and-apply",
      });
      if (replay) return replay;
      return await this.serializeTargetMutation(async () => {
        const queuedReplay = await this.coordinator.replayCommand({
          ...input,
          operation: "promote-and-apply",
        });
        if (queuedReplay) return queuedReplay;
        await this.coordinator.assertServerPreflightEvaluation(input.proposalId);
        return await this.coordinator.promoteAndApply(input);
      });
    });
  }

  async previewRollback(
    proposalId: string,
    operator: string,
    expectedRevision: number,
  ): Promise<{ preview: ApplicationPreview; description: ApplicationPreviewDescription }> {
    return await this.perform(async () => {
      const preview = await this.coordinator.previewRollback({
        proposalId,
        operator,
        expectedRevision,
      });
      const description = await this.coordinator.describePreview({
        token: preview.token,
        kind: "rollback-applied",
        proposalId,
        operator,
        expectedRevision,
      });
      return { preview, description };
    });
  }

  async rollback(input: {
    commandId: string;
    proposalId: string;
    operator: string;
    reason: string;
    expectedRevision: number;
    token: string;
  }): Promise<ApplicationCommandResult> {
    return await this.perform(async () => {
      const replay = await this.coordinator.replayCommand({
        ...input,
        operation: "rollback-applied",
      });
      if (replay) return replay;
      return await this.serializeTargetMutation(async () => {
        const queuedReplay = await this.coordinator.replayCommand({
          ...input,
          operation: "rollback-applied",
        });
        return queuedReplay ?? await this.coordinator.rollbackAppliedPromotion(input);
      });
    });
  }

  async adoptLegacyPromotion(input: {
    commandId: string;
    proposalId: string;
    operator: string;
    reason: string;
    expectedRevision: number;
  }): Promise<ApplicationCommandResult> {
    return await this.perform(async () => {
      const command = { ...input, mode: "adopt" as const };
      const replay = await this.coordinator.replayReconcileCommand(command);
      if (replay) return replay;
      return await this.serializeTargetMutation(async () => {
        const queuedReplay = await this.coordinator.replayReconcileCommand(command);
        return queuedReplay ?? await this.coordinator.reconcilePromoted(command);
      });
    });
  }

  async withTargetMutation<T>(operation: () => Promise<T>): Promise<T> {
    return await this.perform(async () => await this.serializeTargetMutation(operation));
  }

  private async serializeTargetMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.targetMutationQueue;
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        const release = this.supervisor.beginEvolutionMutation();
        try {
          return await operation();
        } finally {
          release();
        }
      });
    this.targetMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private perform<T>(operation: () => Promise<T>): Promise<T> {
    if (this.sealed) {
      throw new EvolutionServiceError(
        "SERVICE_CLOSED",
        "Evolution control is closed for this project",
      );
    }
    const result = Promise.resolve().then(operation);
    this.inFlight.add(result);
    void result.then(
      () => this.inFlight.delete(result),
      () => this.inFlight.delete(result),
    );
    return result;
  }

  private async proposeBound(
    idempotencyKey: string,
    candidate: EvolutionCandidate,
    policy: EvolutionPolicy,
    promptContent?: Uint8Array,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number; deduplicated: boolean }> {
    const id = proposalIdFor(idempotencyKey);
    const existing = this.coordinator.readProposal(id);
    if (existing) {
      return await this.resolveProposalReplay(existing, candidate, policy);
    }
    try {
      const created = await this.coordinator.propose({
        id,
        candidate,
        policy,
        ...(promptContent ? { promptContent } : {}),
      });
      return { ...created, deduplicated: false };
    } catch (error) {
      const raced = this.coordinator.readProposal(id);
      if (raced) return await this.resolveProposalReplay(raced, candidate, policy);
      throw error;
    }
  }

  private async resolveProposalReplay(
    existing: EvolutionProposal,
    candidate: EvolutionCandidate,
    policy: EvolutionPolicy,
  ): Promise<{ proposal: EvolutionProposal; committedRevision: number; deduplicated: true }> {
    if (!canonicalEqual(existing.candidate, candidate) || !canonicalEqual(existing.policy, policy)) {
      throw new EvolutionServiceError(
        "COMMAND_CONFLICT",
        "Idempotency key was already used for a different evolution proposal",
      );
    }
    const { revision } = await this.coordinator.readCatalogSnapshot();
    return { proposal: existing, committedRevision: revision, deduplicated: true };
  }
}

function policyFor(allowedPromptPaths: string[]): EvolutionPolicy {
  return {
    version: EVOLUTION_DOMAIN_VERSION,
    capabilities: {
      automaticExecution: false,
      automaticPromotion: false,
      networkPublication: false,
      secretStorage: false,
    },
    allowedPromptPaths,
  };
}

function proposalIdFor(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return `evo-${digest.slice(0, 48)}`;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

function sanitizeApplication(
  application: ReturnType<EvolutionApplicationCoordinator["getApplication"]>,
): unknown {
  if (!application) return null;
  return {
    proposalId: application.proposalId,
    target: application.target,
    status: application.status,
    beforeTargetDigest: application.beforeTargetDigest,
    afterTargetDigest: application.afterTargetDigest,
    rollbackSafe: application.rollbackSafe,
    catalogRevision: application.catalogRevision,
    operator: application.operator,
    reason: application.reason,
    appliedAt: application.appliedAt,
  };
}
