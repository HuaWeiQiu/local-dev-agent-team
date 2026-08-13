import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  computeCandidateDigest,
  type EvolutionProposal,
} from "./domain.js";
import type { DurableEvolutionCatalog } from "./persistence.js";
import {
  EvolutionApplicationError,
  MAX_APPLICATION_HISTORY_DEPTH,
  applicationHistoryDepth,
  decodeUtf8,
  isolate,
  requireNonEmpty,
  sha256Canonical,
  sha256Text,
  targetFromCandidate,
  targetKey,
  targetStatesEqual,
  type ApplicationCommandKind,
  type ApplicationPreview,
  type ApplicationPreviewDescription,
  type ApplicationRecord,
  type EvolutionApplicationState,
  type TargetDigestState,
} from "./application-shared.js";
import type { EvolutionApplicationTargets } from "./application-target.js";

export type PreviewRecord = {
  readonly token: string;
  readonly tokenDigest: string;
  readonly kind: ApplicationCommandKind;
  readonly proposalId: string;
  readonly candidateDigest: string;
  readonly catalogRevision: number;
  readonly activeProposalId: string | null;
  readonly currentTargetDigest: string | null;
  readonly operator: string;
  readonly expiresAt: string;
  readonly beforeTarget: TargetDigestState;
  readonly afterTarget: TargetDigestState;
  readonly previousApplication: ApplicationRecord | null;
  readonly previousActiveProposalId: string | null;
  readonly expectedCatalogRevisionAfter: number;
};

/**
 * Coordinator-owned gates the preview lifecycle must enforce before minting or
 * consuming a preview token.
 */
export interface EvolutionApplicationPreviewHost {
  assertOpen(): void;
  assertWritable(): void;
  requireProposal(proposalId: string): EvolutionProposal;
  assertPolicyAllows(proposal: EvolutionProposal): void;
  assertPromotable(proposal: EvolutionProposal): void;
  assertNoUnreconciledConflict(proposal: EvolutionProposal, op: "promote" | "rollback"): void;
}

export interface EvolutionApplicationPreviewEnvironment {
  readonly catalog: DurableEvolutionCatalog;
  readonly targets: EvolutionApplicationTargets;
  readonly state: EvolutionApplicationState;
  readonly host: EvolutionApplicationPreviewHost;
  readonly now: () => number;
  readonly previewTtlMs: number;
}

/**
 * Immutable, TTL-bound preview tokens for promotion and rollback commands.
 * Preview material is computed from live target state at mint time and is
 * consumed exactly once by the matching command.
 */
export class EvolutionApplicationPreviewStore {
  readonly #catalog: DurableEvolutionCatalog;
  readonly #targets: EvolutionApplicationTargets;
  readonly #state: EvolutionApplicationState;
  readonly #host: EvolutionApplicationPreviewHost;
  readonly #now: () => number;
  readonly #previewTtlMs: number;
  readonly #previews = new Map<string, PreviewRecord>();

  constructor(environment: EvolutionApplicationPreviewEnvironment) {
    this.#catalog = environment.catalog;
    this.#targets = environment.targets;
    this.#state = environment.state;
    this.#host = environment.host;
    this.#now = environment.now;
    this.#previewTtlMs = environment.previewTtlMs;
  }

  async createPromotionPreview(input: {
    proposalId: string;
    operator: string;
    expectedRevision?: number;
  }): Promise<ApplicationPreview> {
    this.#host.assertWritable();
    const { revision, snapshot: _snapshot } = await this.#catalog.readSnapshot();
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== revision
    ) {
      throw new EvolutionApplicationError(
        "STALE_CATALOG_REVISION",
        `Catalog revision ${input.expectedRevision} is stale; current is ${revision}`,
      );
    }
    const proposal = this.#host.requireProposal(input.proposalId);
    this.#host.assertPolicyAllows(proposal);
    this.#host.assertPromotable(proposal);
    this.#host.assertNoUnreconciledConflict(proposal, "promote");

    const candidateDigest = computeCandidateDigest(proposal.candidate);
    const target = targetFromCandidate(proposal.candidate);
    const activeProposalId = this.#catalog.getActiveProposalId(target);
    const beforeTarget = await this.#targets.readTargetState(proposal.candidate);
    const afterTarget = await this.#targets.plannedAfterState(proposal, beforeTarget);
    const previousApplication = activeProposalId
      ? (this.#state.applications.get(activeProposalId) ?? null)
      : null;
    if (
      previousApplication &&
      !targetStatesEqual(beforeTarget, previousApplication.afterTarget)
    ) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Active target for '${activeProposalId}' no longer matches its application proof`,
      );
    }
    if (
      previousApplication &&
      applicationHistoryDepth(previousApplication) >= MAX_APPLICATION_HISTORY_DEPTH
    ) {
      throw new EvolutionApplicationError(
        "POLICY_DENIED",
        `Application history for '${targetKey(target)}' reached the bounded depth of ${MAX_APPLICATION_HISTORY_DEPTH}`,
      );
    }
    const operator = requireNonEmpty(input.operator, "operator");
    const expiresAt = new Date(this.#now() + this.#previewTtlMs).toISOString();
    const token = randomBytes(32).toString("base64url");
    const preview: PreviewRecord = {
      token,
      tokenDigest: sha256Text(token),
      kind: "promote-and-apply",
      proposalId: proposal.id,
      candidateDigest,
      catalogRevision: revision,
      activeProposalId,
      currentTargetDigest: beforeTarget.digest,
      operator,
      expiresAt,
      beforeTarget,
      afterTarget,
      previousApplication,
      previousActiveProposalId: activeProposalId,
      expectedCatalogRevisionAfter: revision + 1,
    };
    this.#previews.set(preview.tokenDigest, isolate(preview));
    return toPublicPreview(preview);
  }

  async createRollbackPreview(input: {
    proposalId: string;
    operator: string;
    expectedRevision?: number;
  }): Promise<ApplicationPreview> {
    this.#host.assertWritable();
    const { revision } = await this.#catalog.readSnapshot();
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== revision
    ) {
      throw new EvolutionApplicationError(
        "STALE_CATALOG_REVISION",
        `Catalog revision ${input.expectedRevision} is stale; current is ${revision}`,
      );
    }
    const proposal = this.#host.requireProposal(input.proposalId);
    this.#host.assertPolicyAllows(proposal);
    if (proposal.status !== "promoted") {
      throw new EvolutionApplicationError(
        "INVALID_LIFECYCLE",
        `Proposal '${proposal.id}' must be promoted to preview rollback (status=${proposal.status})`,
      );
    }
    const target = targetFromCandidate(proposal.candidate);
    const activeProposalId = this.#catalog.getActiveProposalId(target);
    if (activeProposalId !== proposal.id) {
      throw new EvolutionApplicationError(
        "ACTIVE_TARGET_CONFLICT",
        `Proposal '${proposal.id}' is not the active promotion for its target`,
      );
    }
    const application = this.#state.applications.get(proposal.id);
    if (!application) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Promoted proposal '${proposal.id}' has no application proof; use reconcilePromoted before rollback`,
      );
    }
    if (!application.rollbackSafe) {
      throw new EvolutionApplicationError(
        "RECOVERY_REQUIRED",
        `Reconciled proposal '${proposal.id}' has no verified predecessor material and cannot be rolled back`,
      );
    }

    const candidateDigest = computeCandidateDigest(proposal.candidate);
    const beforeTarget = await this.#targets.readTargetState(proposal.candidate);
    if (!targetStatesEqual(beforeTarget, application.afterTarget)) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        `Active target for '${proposal.id}' drifted from applied digest`,
      );
    }
    const afterTarget = await this.#targets.plannedRollbackState(proposal, application);
    const operator = requireNonEmpty(input.operator, "operator");
    const expiresAt = new Date(this.#now() + this.#previewTtlMs).toISOString();
    const token = randomBytes(32).toString("base64url");
    const preview: PreviewRecord = {
      token,
      tokenDigest: sha256Text(token),
      kind: "rollback-applied",
      proposalId: proposal.id,
      candidateDigest,
      catalogRevision: revision,
      activeProposalId,
      currentTargetDigest: beforeTarget.digest,
      operator,
      expiresAt,
      beforeTarget,
      afterTarget,
      previousApplication: application,
      previousActiveProposalId: activeProposalId,
      expectedCatalogRevisionAfter: revision + 1,
    };
    this.#previews.set(preview.tokenDigest, isolate(preview));
    return toPublicPreview(preview);
  }

  /**
   * Return the exact human-review material already bound to an unexpired
   * preview. This never accepts a path or replacement content from the caller.
   */
  async describe(input: {
    token: string;
    kind: "promote-and-apply" | "rollback-applied";
    proposalId: string;
    operator: string;
    expectedRevision: number;
  }): Promise<ApplicationPreviewDescription> {
    this.#host.assertOpen();
    const preview = this.consume(input.token, input);
    const proposal = this.#host.requireProposal(input.proposalId);
    if (proposal.candidate.kind === "strategy-blueprint") {
      if (
        preview.beforeTarget.kind !== "strategy-blueprint" ||
        preview.afterTarget.kind !== "strategy-blueprint"
      ) {
        throw new EvolutionApplicationError(
          "STALE_PREVIEW",
          "Preview target kind no longer matches its proposal",
        );
      }
      return isolate({
        kind: input.kind,
        proposalId: proposal.id,
        before: {
          kind: "strategy-blueprint" as const,
          identity: preview.beforeTarget.identity,
          digest: preview.beforeTarget.digest,
          present: preview.beforeTarget.present,
          definition: preview.beforeTarget.strategyDefinition ?? null,
        },
        after: {
          kind: "strategy-blueprint" as const,
          identity: preview.afterTarget.identity,
          digest: preview.afterTarget.digest,
          present: preview.afterTarget.present,
          definition: preview.afterTarget.strategyDefinition ?? null,
        },
      });
    }

    if (
      preview.beforeTarget.kind !== "role-prompt" ||
      preview.afterTarget.kind !== "role-prompt"
    ) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview target kind no longer matches its proposal",
      );
    }
    const live = await this.#targets.readTargetState(proposal.candidate);
    if (!targetStatesEqual(live, preview.beforeTarget)) {
      throw new EvolutionApplicationError(
        "TARGET_DRIFTED",
        "Prompt target changed before preview material was reviewed",
      );
    }
    const beforeContent = preview.beforeTarget.present
      ? await this.#targets.readLivePromptText(proposal.candidate.path, preview.beforeTarget.digest!)
      : null;
    const afterContent = preview.afterTarget.present
      ? decodeUtf8(await this.#targets.readPromptObject(preview.afterTarget.digest!))
      : null;
    return isolate({
      kind: input.kind,
      proposalId: proposal.id,
      before: {
        kind: "role-prompt" as const,
        identity: preview.beforeTarget.identity,
        digest: preview.beforeTarget.digest,
        present: preview.beforeTarget.present,
        content: beforeContent,
      },
      after: {
        kind: "role-prompt" as const,
        identity: preview.afterTarget.identity,
        digest: preview.afterTarget.digest,
        present: preview.afterTarget.present,
        content: afterContent,
      },
    });
  }

  consume(
    token: string,
    expected: {
      kind: ApplicationCommandKind;
      proposalId: string;
      operator: string;
      expectedRevision: number;
    },
  ): PreviewRecord {
    if (typeof token !== "string" || !token.trim()) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token is required");
    }
    const digest = sha256Text(token);
    const preview = this.#previews.get(digest);
    if (!preview) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token is unknown or already used");
    }
    if (preview.kind !== expected.kind || preview.proposalId !== expected.proposalId) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview token does not match command kind or proposal",
      );
    }
    if (preview.operator !== expected.operator) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview token operator does not match command operator",
      );
    }
    if (preview.catalogRevision !== expected.expectedRevision) {
      throw new EvolutionApplicationError(
        "STALE_PREVIEW",
        "Preview token catalog revision does not match expectedRevision",
      );
    }
    if (Date.parse(preview.expiresAt) <= this.#now()) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token has expired");
    }
    // Constant-time compare of token material when present
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(preview.token);
    if (
      tokenBuf.length !== expectedBuf.length ||
      !timingSafeEqual(tokenBuf, expectedBuf)
    ) {
      throw new EvolutionApplicationError("STALE_PREVIEW", "Preview token mismatch");
    }
    return preview;
  }

  drop(tokenDigest: string): void {
    this.#previews.delete(tokenDigest);
  }

  clear(): void {
    this.#previews.clear();
  }
}

function toPublicPreview(preview: PreviewRecord): ApplicationPreview {
  const publicTarget = (
    target: TargetDigestState,
  ): Omit<TargetDigestState, "strategyDefinition"> => ({
    kind: target.kind,
    identity: target.identity,
    digest: target.digest,
    present: target.present,
    ...(target.mode === undefined ? {} : { mode: target.mode }),
  });
  return isolate({
    token: preview.token,
    kind: preview.kind,
    proposalId: preview.proposalId,
    candidateDigest: preview.candidateDigest,
    catalogRevision: preview.catalogRevision,
    activeProposalId: preview.activeProposalId,
    currentTargetDigest: preview.currentTargetDigest,
    operator: preview.operator,
    expiresAt: preview.expiresAt,
    beforeTarget: publicTarget(preview.beforeTarget),
    afterTarget: publicTarget(preview.afterTarget),
  });
}
