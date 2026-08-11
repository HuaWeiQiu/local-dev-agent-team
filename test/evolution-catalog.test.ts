import { describe, expect, it } from "vitest";
import {
  createEvolutionCatalog,
  EvolutionCatalog,
  EvolutionCatalogConflictError,
  EvolutionCatalogError,
  EvolutionCatalogNotFoundError,
  EVOLUTION_CATALOG_VERSION,
  restoreEvolutionCatalog,
  type EvolutionCatalogSnapshot,
} from "../src/evolution/catalog.js";
import {
  computeCandidateDigest,
  createEvolutionTrustContext,
  EvolutionLifecycleError,
  EvolutionPromotionError,
  EvolutionValidationError,
  type EvolutionProposal,
  type EvolutionTrustContext,
} from "../src/evolution/domain.js";

const now = "2026-08-11T01:00:00.000Z";

const defaultTrust: EvolutionTrustContext = createEvolutionTrustContext({
  roles: {
    orchestrator: { allowedProfiles: ["codex-planner"] },
    architect: { allowedProfiles: ["codex-planner"] },
    worker: {
      allowedProfiles: ["codex-worker"],
      promptFile: "prompts/worker.md",
    },
    reviewer: {
      allowedProfiles: ["codex-planner"],
      promptFile: "prompts/reviewer.md",
    },
    tester: { allowedProfiles: ["codex-planner"] },
  },
});

function validPolicy(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    capabilities: {
      automaticExecution: false,
      automaticPromotion: false,
      networkPublication: false,
      secretStorage: false,
    },
    allowedPromptPaths: ["prompts/worker.md", "prompts/reviewer.md"],
    ...overrides,
  };
}

function validStrategyCandidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "strategy-blueprint",
    name: "serial-review",
    definition: {
      topology: { mode: "sequential" },
      maxParallel: 1,
      roleProfiles: {},
      approvalGates: ["final"],
    },
    ...overrides,
  };
}

function validPromptCandidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "role-prompt",
    path: "prompts/worker.md",
    contentDigest: "a".repeat(64),
    ...overrides,
  };
}

function humanDecision(overrides: Record<string, unknown> = {}) {
  return {
    actor: "operator",
    reason: "Promote after review",
    decidedAt: "2026-08-11T01:03:00.000Z",
    ...overrides,
  };
}

function boundEvidence(
  proposal: EvolutionProposal,
  items: Array<Record<string, unknown>> = [
    {
      kind: "deterministic",
      id: "unit-tests",
      status: "pass",
      summary: "Focused catalog tests passed",
    },
    {
      kind: "advisory",
      id: "reviewer",
      verdict: "approve",
      summary: "Approve after independent review",
    },
  ],
) {
  return {
    proposalId: proposal.id,
    candidateDigest: computeCandidateDigest(proposal.candidate),
    items,
  };
}

function createCatalog(): EvolutionCatalog {
  return createEvolutionCatalog(defaultTrust);
}

function propose(
  catalog: EvolutionCatalog,
  overrides: {
    id?: string;
    createdAt?: string;
    policy?: unknown;
    candidate?: unknown;
  } = {},
): EvolutionProposal {
  return catalog.propose({
    id: overrides.id ?? "prop-1",
    createdAt: overrides.createdAt ?? now,
    policy: overrides.policy ?? validPolicy(),
    candidate: overrides.candidate ?? validStrategyCandidate(),
  });
}

function toEvaluated(
  catalog: EvolutionCatalog,
  proposalId = "prop-1",
  items?: Array<Record<string, unknown>>,
): EvolutionProposal {
  const current = catalog.getProposal(proposalId);
  if (!current) {
    throw new Error(`Proposal '${proposalId}' missing before evaluation`);
  }
  const createdMs = Date.parse(current.createdAt);
  const evaluatingAt = new Date(createdMs + 60_000).toISOString();
  const evaluatedAt = new Date(createdMs + 120_000).toISOString();
  catalog.beginEvaluation(proposalId, evaluatingAt);
  const evaluating = catalog.getProposal(proposalId)!;
  return catalog.evaluate(proposalId, boundEvidence(evaluating, items), evaluatedAt);
}

describe("EvolutionCatalog proposal lifecycle", () => {
  it("proposes, evaluates, promotes, replaces, and rolls back with active pointers", () => {
    const catalog = createCatalog();

    const proposed = propose(catalog, { id: "prop-a" });
    expect(proposed.status).toBe("proposed");
    expect(proposed.id).toBe("prop-a");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      null,
    );

    const evaluating = catalog.beginEvaluation("prop-a", "2026-08-11T01:01:00.000Z");
    expect(evaluating.status).toBe("evaluating");

    const evaluated = catalog.evaluate(
      "prop-a",
      boundEvidence(evaluating),
      "2026-08-11T01:02:00.000Z",
    );
    expect(evaluated.status).toBe("evaluated");
    expect(evaluated.evaluation?.result.passed).toBe(true);

    const { proposal: promoted, record: promotion } = catalog.promote(
      "prop-a",
      boundEvidence(evaluated),
      humanDecision(),
    );
    expect(promoted.status).toBe("promoted");
    expect(promotion).toMatchObject({
      kind: "promotion",
      proposalId: "prop-a",
      previousActiveProposalId: null,
    });
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-a",
    );

    // Replacement proposal for the same strategy target.
    propose(catalog, {
      id: "prop-b",
      createdAt: "2026-08-11T02:00:00.000Z",
      candidate: validStrategyCandidate({
        definition: {
          topology: { mode: "sequential" },
          maxParallel: 1,
          roleProfiles: { worker: "codex-worker" },
          approvalGates: ["final"],
        },
      }),
    });
    const evaluatedB = toEvaluated(catalog, "prop-b");
    const { proposal: promotedB, record: promotionB } = catalog.promote(
      "prop-b",
      boundEvidence(evaluatedB),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );
    expect(promotedB.status).toBe("promoted");
    expect(promotionB.previousActiveProposalId).toBe("prop-a");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-b",
    );

    const { proposal: rolledBack, record: rollback } = catalog.rollback(
      "prop-b",
      humanDecision({
        reason: "Restore prior active strategy",
        decidedAt: "2026-08-11T02:04:00.000Z",
      }),
    );
    expect(rolledBack.status).toBe("rolled-back");
    expect(rollback).toMatchObject({
      kind: "rollback",
      proposalId: "prop-b",
      restoredActiveProposalId: "prop-a",
    });
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-a",
    );

    // Rolling back the restored active proposal clears the pointer.
    const { record: rollbackA } = catalog.rollback(
      "prop-a",
      humanDecision({
        reason: "Clear strategy active pointer",
        decidedAt: "2026-08-11T02:05:00.000Z",
      }),
    );
    expect(rollbackA.restoredActiveProposalId).toBeNull();
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      null,
    );
  });

  it("rejects evaluated proposals without changing the active pointer", () => {
    const catalog = createCatalog();
    propose(catalog);
    const evaluated = toEvaluated(catalog);

    const { proposal: rejected, record } = catalog.reject(
      "prop-1",
      humanDecision({ reason: "Not ready", decidedAt: "2026-08-11T01:04:00.000Z" }),
    );
    expect(rejected.status).toBe("rejected");
    expect(record.kind).toBe("rejection");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      null,
    );
    expect(catalog.getProposal("prop-1")?.status).toBe("rejected");
    expect(evaluated.status).toBe("evaluated");
  });

  it("tracks active pointers independently for strategy names and role-prompt paths", () => {
    const catalog = createCatalog();

    propose(catalog, {
      id: "strategy-1",
      candidate: validStrategyCandidate({ name: "serial-review" }),
    });
    const strategyEvaluated = toEvaluated(catalog, "strategy-1");
    catalog.promote(
      "strategy-1",
      boundEvidence(strategyEvaluated),
      humanDecision({ decidedAt: "2026-08-11T01:03:00.000Z" }),
    );

    propose(catalog, {
      id: "prompt-1",
      createdAt: "2026-08-11T01:10:00.000Z",
      candidate: validPromptCandidate(),
    });
    const promptEvaluated = toEvaluated(catalog, "prompt-1");
    catalog.promote(
      "prompt-1",
      boundEvidence(promptEvaluated),
      humanDecision({ decidedAt: "2026-08-11T01:13:00.000Z" }),
    );

    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "strategy-1",
    );
    expect(catalog.getActiveProposalId({ kind: "role-prompt", path: "prompts/worker.md" })).toBe(
      "prompt-1",
    );

    // Different strategy name is a distinct target.
    propose(catalog, {
      id: "strategy-2",
      createdAt: "2026-08-11T01:20:00.000Z",
      candidate: validStrategyCandidate({ name: "fast-lane" }),
    });
    const strategy2 = toEvaluated(catalog, "strategy-2");
    catalog.promote(
      "strategy-2",
      boundEvidence(strategy2),
      humanDecision({ decidedAt: "2026-08-11T01:23:00.000Z" }),
    );
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "strategy-1",
    );
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "fast-lane" })).toBe(
      "strategy-2",
    );
  });
});

describe("EvolutionCatalog validation and rejection paths", () => {
  it("enforces globally unique proposal IDs", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "shared-id" });
    expect(() => propose(catalog, { id: "shared-id" })).toThrow(EvolutionCatalogConflictError);
    expect(() => propose(catalog, { id: "shared-id" })).toThrow(/already present/i);
    expect(catalog.snapshot().proposals).toHaveLength(1);

    // Domain trims proposal ids; trimmed-equivalent input must not overwrite state.
    const beforeTrimDup = catalog.snapshot();
    expect(() => propose(catalog, { id: " shared-id " })).toThrow(EvolutionCatalogConflictError);
    expect(() => propose(catalog, { id: " shared-id " })).toThrow(/already present/i);
    expect(catalog.snapshot()).toEqual(beforeTrimDup);
    expect(catalog.getProposal("shared-id")?.status).toBe("proposed");
    expect(catalog.snapshot().proposals).toHaveLength(1);
  });

  it("rejects invalid inputs through domain APIs without partial state", () => {
    const catalog = createCatalog();
    const before = catalog.snapshot();

    expect(() =>
      catalog.propose({
        id: "bad-policy",
        createdAt: now,
        policy: {
          ...validPolicy(),
          capabilities: {
            automaticExecution: true,
            automaticPromotion: false,
            networkPublication: false,
            secretStorage: false,
          },
        },
        candidate: validStrategyCandidate(),
      }),
    ).toThrow(EvolutionValidationError);

    expect(() =>
      catalog.propose({
        id: "bad-candidate",
        createdAt: now,
        policy: validPolicy(),
        candidate: validPromptCandidate({ path: "prompts/unknown.md" }),
      }),
    ).toThrow(EvolutionValidationError);

    expect(() =>
      catalog.propose({
        id: "bad-id!",
        createdAt: now,
        policy: validPolicy(),
        candidate: validStrategyCandidate(),
      }),
    ).toThrow(EvolutionValidationError);

    expect(catalog.snapshot()).toEqual(before);
  });

  it("rejects illegal transitions and missing proposals without mutation", () => {
    const catalog = createCatalog();
    propose(catalog);
    const before = catalog.snapshot();

    expect(() => catalog.evaluate("prop-1", {}, "2026-08-11T01:02:00.000Z")).toThrow(
      EvolutionLifecycleError,
    );
    expect(() => catalog.beginEvaluation("missing", "2026-08-11T01:01:00.000Z")).toThrow(
      EvolutionCatalogNotFoundError,
    );
    expect(() =>
      catalog.promote("prop-1", {}, humanDecision()),
    ).toThrow(EvolutionPromotionError);
    expect(() =>
      catalog.reject("prop-1", humanDecision()),
    ).toThrow(EvolutionLifecycleError);
    expect(() =>
      catalog.rollback("prop-1", humanDecision()),
    ).toThrow(EvolutionLifecycleError);

    expect(catalog.snapshot()).toEqual(before);
    expect(catalog.getProposal("prop-1")?.status).toBe("proposed");
  });

  it("records failed deterministic evaluation but vetoes promotion", () => {
    const catalog = createCatalog();
    propose(catalog);
    catalog.beginEvaluation("prop-1", "2026-08-11T01:01:00.000Z");
    const evaluating = catalog.getProposal("prop-1")!;

    const failed = catalog.evaluate(
      "prop-1",
      boundEvidence(evaluating, [
        {
          kind: "deterministic",
          id: "unit-tests",
          status: "fail",
          summary: "tests failed",
        },
        {
          kind: "advisory",
          id: "reviewer",
          verdict: "approve",
          summary: "advisory still approves",
        },
      ]),
      "2026-08-11T01:02:00.000Z",
    );
    expect(failed.status).toBe("evaluated");
    expect(failed.evaluation?.result.passed).toBe(false);
    expect(failed.evaluation?.result.deterministicPassed).toBe(false);

    const beforePromote = catalog.snapshot();
    expect(() =>
      catalog.promote(
        "prop-1",
        boundEvidence(failed, [
          {
            kind: "deterministic",
            id: "unit-tests",
            status: "fail",
            summary: "tests failed",
          },
          {
            kind: "advisory",
            id: "reviewer",
            verdict: "approve",
            summary: "advisory still approves",
          },
        ]),
        humanDecision(),
      ),
    ).toThrow(EvolutionPromotionError);
    expect(catalog.snapshot()).toEqual(beforePromote);
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      null,
    );
  });

  it("records advisory rejection and blocks promotion", () => {
    const catalog = createCatalog();
    propose(catalog);
    catalog.beginEvaluation("prop-1", "2026-08-11T01:01:00.000Z");
    const evaluating = catalog.getProposal("prop-1")!;

    const evaluated = catalog.evaluate(
      "prop-1",
      boundEvidence(evaluating, [
        {
          kind: "deterministic",
          id: "unit-tests",
          status: "pass",
          summary: "ok",
        },
        {
          kind: "advisory",
          id: "reviewer",
          verdict: "request_changes",
          summary: "needs work",
        },
      ]),
      "2026-08-11T01:02:00.000Z",
    );
    expect(evaluated.evaluation?.result.passed).toBe(false);
    expect(evaluated.evaluation?.result.advisoryPassed).toBe(false);

    expect(() =>
      catalog.promote(
        "prop-1",
        boundEvidence(evaluated, [
          {
            kind: "deterministic",
            id: "unit-tests",
            status: "pass",
            summary: "ok",
          },
          {
            kind: "advisory",
            id: "reviewer",
            verdict: "request_changes",
            summary: "needs work",
          },
        ]),
        humanDecision(),
      ),
    ).toThrow(EvolutionPromotionError);
  });

  it("rejects mismatched promotion evidence and non-human decisions", () => {
    const catalog = createCatalog();
    propose(catalog);
    const evaluated = toEvaluated(catalog);
    const before = catalog.snapshot();

    // Evidence bound to a different proposal id.
    expect(() =>
      catalog.promote(
        "prop-1",
        {
          proposalId: "other",
          candidateDigest: computeCandidateDigest(evaluated.candidate),
          items: [
            {
              kind: "deterministic",
              id: "unit-tests",
              status: "pass",
              summary: "ok",
            },
          ],
        },
        humanDecision(),
      ),
    ).toThrow(/bound to proposal/i);

    // Evidence that does not match the recorded evaluation snapshot.
    expect(() =>
      catalog.promote(
        "prop-1",
        boundEvidence(evaluated, [
          {
            kind: "deterministic",
            id: "unit-tests",
            status: "pass",
            summary: "different summary than evaluation",
          },
        ]),
        humanDecision(),
      ),
    ).toThrow(EvolutionPromotionError);

    // Non-human / empty actor.
    expect(() =>
      catalog.promote(
        "prop-1",
        boundEvidence(evaluated),
        { actor: "   ", reason: "nope", decidedAt: "2026-08-11T01:03:00.000Z" },
      ),
    ).toThrow(EvolutionValidationError);

    expect(() =>
      catalog.promote(
        "prop-1",
        boundEvidence(evaluated),
        { actor: "operator", reason: "", decidedAt: "2026-08-11T01:03:00.000Z" },
      ),
    ).toThrow(EvolutionValidationError);

    expect(catalog.snapshot()).toEqual(before);
  });
});

describe("EvolutionCatalog immutability, determinism, and provenance", () => {
  it("orders snapshot proposals, audits, and active pointers deterministically", () => {
    const catalog = createCatalog();

    propose(catalog, {
      id: "prop-z",
      candidate: validStrategyCandidate({ name: "serial-review" }),
    });
    propose(catalog, {
      id: "prop-a",
      createdAt: "2026-08-11T01:00:01.000Z",
      candidate: validPromptCandidate(),
    });
    propose(catalog, {
      id: "prop-m",
      createdAt: "2026-08-11T01:00:02.000Z",
      candidate: validStrategyCandidate({ name: "fast-lane" }),
    });

    const evalZ = toEvaluated(catalog, "prop-z");
    catalog.promote(
      "prop-z",
      boundEvidence(evalZ),
      humanDecision({ decidedAt: "2026-08-11T01:03:00.000Z" }),
    );

    const evalA = toEvaluated(catalog, "prop-a");
    catalog.promote(
      "prop-a",
      boundEvidence(evalA),
      humanDecision({ decidedAt: "2026-08-11T01:13:00.000Z" }),
    );

    toEvaluated(catalog, "prop-m");
    catalog.reject(
      "prop-m",
      humanDecision({ reason: "Not selected", decidedAt: "2026-08-11T01:23:00.000Z" }),
    );

    const first = catalog.snapshot();
    const second = catalog.snapshot();

    expect(first.version).toBe(EVOLUTION_CATALOG_VERSION);
    expect(first.proposals.map((p) => p.id)).toEqual(["prop-a", "prop-m", "prop-z"]);
    expect(first.auditRecords.map((r) => `${r.kind}:${r.proposalId}`)).toEqual([
      "promotion:prop-z",
      "promotion:prop-a",
      "rejection:prop-m",
    ]);
    expect(first.activeProposals.map((p) => `${p.target.kind}:${"name" in p.target ? p.target.name : p.target.path}`)).toEqual([
      "role-prompt:prompts/worker.md",
      "strategy-blueprint:serial-review",
    ]);

    // Deterministic across repeated snapshots.
    expect(second).toEqual(first);

    // Deep isolation: mutating a snapshot must not affect catalog or later snapshots.
    const mutable = first as unknown as {
      proposals: Array<{ status: string; candidate: { name?: string } }>;
      auditRecords: Array<{ actor: string }>;
      activeProposals: Array<{ proposalId: string }>;
    };
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.proposals)).toBe(true);
    expect(Object.isFrozen(first.proposals[0])).toBe(true);

    expect(() => {
      (mutable.proposals as unknown as EvolutionProposal[]).push(first.proposals[0]!);
    }).toThrow();
    expect(() => {
      mutable.proposals[0]!.status = "rejected";
    }).toThrow();
    expect(() => {
      mutable.auditRecords[0]!.actor = "attacker";
    }).toThrow();
    expect(() => {
      mutable.activeProposals[0]!.proposalId = "forged";
    }).toThrow();

    // getProposal also returns isolated copies.
    const copy = catalog.getProposal("prop-z")!;
    expect(Object.isFrozen(copy)).toBe(true);
    expect(() => {
      (copy as { status: string }).status = "rejected";
    }).toThrow();
    expect(catalog.getProposal("prop-z")?.status).toBe("promoted");

    expect(catalog.snapshot()).toEqual(first);
  });

  it("uses only internal promotion provenance for rollback restoration", () => {
    const catalog = createCatalog();

    propose(catalog, { id: "prop-old" });
    const oldEval = toEvaluated(catalog, "prop-old");
    catalog.promote(
      "prop-old",
      boundEvidence(oldEval),
      humanDecision({ decidedAt: "2026-08-11T01:03:00.000Z" }),
    );

    propose(catalog, {
      id: "prop-new",
      createdAt: "2026-08-11T02:00:00.000Z",
    });
    const newEval = toEvaluated(catalog, "prop-new");
    const { record: promotionNew } = catalog.promote(
      "prop-new",
      boundEvidence(newEval),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );
    expect(promotionNew.previousActiveProposalId).toBe("prop-old");

    // Caller-held promotion record cannot be substituted: rollback has no
    // promotionRecord parameter and uses the internal binding exclusively.
    const { record: rollback } = catalog.rollback(
      "prop-new",
      humanDecision({
        reason: "Restore from internal provenance",
        decidedAt: "2026-08-11T02:04:00.000Z",
      }),
    );
    expect(rollback.restoredActiveProposalId).toBe("prop-old");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-old",
    );

    // Double rollback is illegal; state remains unchanged.
    const after = catalog.snapshot();
    expect(() =>
      catalog.rollback(
        "prop-new",
        humanDecision({
          reason: "Already rolled back",
          decidedAt: "2026-08-11T02:05:00.000Z",
        }),
      ),
    ).toThrow(EvolutionLifecycleError);
    expect(catalog.snapshot()).toEqual(after);
  });

  it("preserves failure atomicity across multi-field catalog updates", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "prop-1" });
    const evaluated = toEvaluated(catalog, "prop-1");
    catalog.promote(
      "prop-1",
      boundEvidence(evaluated),
      humanDecision({ decidedAt: "2026-08-11T01:03:00.000Z" }),
    );

    const snapshotBefore = structuredClone(catalog.snapshot()) as EvolutionCatalogSnapshot;

    // Invalid decision timestamp preceding last transition.
    expect(() =>
      catalog.rollback("prop-1", {
        actor: "operator",
        reason: "too early",
        decidedAt: "2026-08-11T01:00:00.000Z",
      }),
    ).toThrow();

    expect(catalog.snapshot()).toEqual(snapshotBefore);
    expect(catalog.getProposal("prop-1")?.status).toBe("promoted");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-1",
    );
    expect(catalog.snapshot().auditRecords).toHaveLength(1);

    // Successful rollback then proves multi-field atomic success path.
    const { proposal, record } = catalog.rollback(
      "prop-1",
      humanDecision({
        reason: "Rollback after checks",
        decidedAt: "2026-08-11T01:04:00.000Z",
      }),
    );
    expect(proposal.status).toBe("rolled-back");
    expect(record.restoredActiveProposalId).toBeNull();
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      null,
    );
    expect(catalog.snapshot().auditRecords).toHaveLength(2);
  });

  it("does not expose a path to replace internal promotion provenance", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "prop-1" });
    const evaluated = toEvaluated(catalog);
    const { record } = catalog.promote(
      "prop-1",
      boundEvidence(evaluated),
      humanDecision(),
    );

    // Mutating the returned record must not affect rollback provenance.
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      (record as { previousActiveProposalId: string | null }).previousActiveProposalId =
        "forged-previous";
    }).toThrow();

    const { record: rollback } = catalog.rollback(
      "prop-1",
      humanDecision({
        reason: "Use internal record",
        decidedAt: "2026-08-11T01:04:00.000Z",
      }),
    );
    expect(rollback.restoredActiveProposalId).toBeNull();

    // Public API surface does not accept a promotionRecord argument.
    expect(catalog.rollback.length).toBe(2);
  });
});

describe("EvolutionCatalog active rollback and ordering integrity", () => {
  it("rejects rollback of a superseded inactive promotion atomically", () => {
    const catalog = createCatalog();

    propose(catalog, { id: "prop-a" });
    const evalA = toEvaluated(catalog, "prop-a");
    catalog.promote(
      "prop-a",
      boundEvidence(evalA),
      humanDecision({ decidedAt: "2026-08-11T01:03:00.000Z" }),
    );

    propose(catalog, {
      id: "prop-b",
      createdAt: "2026-08-11T02:00:00.000Z",
    });
    const evalB = toEvaluated(catalog, "prop-b");
    catalog.promote(
      "prop-b",
      boundEvidence(evalB),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );

    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-b",
    );
    expect(catalog.getProposal("prop-a")?.status).toBe("promoted");

    const before = catalog.snapshot();
    expect(() =>
      catalog.rollback(
        "prop-a",
        humanDecision({
          reason: "Attempt inactive rollback",
          decidedAt: "2026-08-11T02:04:00.000Z",
        }),
      ),
    ).toThrow(EvolutionCatalogConflictError);
    expect(() =>
      catalog.rollback(
        "prop-a",
        humanDecision({
          reason: "Attempt inactive rollback",
          decidedAt: "2026-08-11T02:04:00.000Z",
        }),
      ),
    ).toThrow(/not the active proposal/i);

    // Failure atomicity: no status, audit, or pointer changes.
    expect(catalog.snapshot()).toEqual(before);
    expect(catalog.getProposal("prop-a")?.status).toBe("promoted");
    expect(catalog.getProposal("prop-b")?.status).toBe("promoted");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-b",
    );
    expect(catalog.snapshot().auditRecords).toHaveLength(2);

    // Rolling back the active proposal restores the prior active pointer.
    const { record } = catalog.rollback(
      "prop-b",
      humanDecision({
        reason: "Restore prior active",
        decidedAt: "2026-08-11T02:05:00.000Z",
      }),
    );
    expect(record.restoredActiveProposalId).toBe("prop-a");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-a",
    );
    expect(catalog.getProposal("prop-a")?.status).toBe("promoted");
    expect(catalog.getProposal("prop-b")?.status).toBe("rolled-back");

    // Every active pointer must reference a still-promoted proposal.
    for (const pointer of catalog.snapshot().activeProposals) {
      expect(catalog.getProposal(pointer.proposalId)?.status).toBe("promoted");
    }
  });

  it("orders equivalent active-target sets identically regardless of insertion order", () => {
    function seed(order: Array<{ id: string; candidate: unknown }>): EvolutionCatalogSnapshot {
      const catalog = createCatalog();
      for (const [index, item] of order.entries()) {
        propose(catalog, {
          id: item.id,
          createdAt: new Date(Date.parse(now) + index * 60_000).toISOString(),
          candidate: item.candidate,
        });
        const evaluated = toEvaluated(catalog, item.id);
        catalog.promote(
          item.id,
          boundEvidence(evaluated),
          humanDecision({
            decidedAt: new Date(Date.parse(now) + index * 60_000 + 180_000).toISOString(),
          }),
        );
      }
      return catalog.snapshot();
    }

    const targets = [
      {
        id: "Prop-Z",
        candidate: validStrategyCandidate({ name: "serial-review" }),
      },
      {
        id: "prop-a",
        candidate: validPromptCandidate({ path: "prompts/worker.md" }),
      },
      {
        id: "Prop-M",
        candidate: validStrategyCandidate({ name: "fast-lane" }),
      },
    ];

    const forward = seed(targets);
    const reverse = seed([...targets].reverse());

    expect(forward.proposals.map((p) => p.id)).toEqual(["Prop-M", "Prop-Z", "prop-a"]);
    expect(reverse.proposals.map((p) => p.id)).toEqual(forward.proposals.map((p) => p.id));
    expect(forward.activeProposals.map((p) => p.proposalId)).toEqual(
      reverse.activeProposals.map((p) => p.proposalId),
    );
    expect(
      forward.activeProposals.map((p) =>
        "name" in p.target ? `${p.target.kind}:${p.target.name}` : `${p.target.kind}:${p.target.path}`,
      ),
    ).toEqual([
      "role-prompt:prompts/worker.md",
      "strategy-blueprint:fast-lane",
      "strategy-blueprint:serial-review",
    ]);
    expect(reverse.activeProposals).toEqual(forward.activeProposals);
  });
});

describe("EvolutionCatalog authoritative runtime boundary", () => {
  it("keeps authoritative stores runtime-private despite public-property tampering", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "prop-a" });
    const evaluatedA = toEvaluated(catalog, "prop-a");
    catalog.promote("prop-a", boundEvidence(evaluatedA), humanDecision());

    expect(Reflect.ownKeys(catalog)).toEqual([]);
    const publicView = catalog as unknown as Record<string, unknown>;
    publicView.proposals = new Map();
    publicView.auditRecords = [];
    publicView.activeByTarget = new Map([["strategy-blueprint:serial-review", "forged"]]);
    publicView.promotionRecords = new Map();

    expect(catalog.getProposal("prop-a")?.status).toBe("promoted");
    expect(catalog.getActiveProposalId({ kind: "strategy-blueprint", name: "serial-review" })).toBe(
      "prop-a",
    );

    propose(catalog, { id: "prop-b", createdAt: "2026-08-11T02:00:00.000Z" });
    const evaluatedB = toEvaluated(catalog, "prop-b");
    const { record: promotionB } = catalog.promote(
      "prop-b",
      boundEvidence(evaluatedB),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );
    expect(promotionB.previousActiveProposalId).toBe("prop-a");

    const { record: rollbackB } = catalog.rollback(
      "prop-b",
      humanDecision({
        reason: "Restore runtime-private pointer",
        decidedAt: "2026-08-11T02:04:00.000Z",
      }),
    );
    expect(rollbackB.restoredActiveProposalId).toBe("prop-a");
  });

  it("rejects accessor-driven reentrant mutations and releases the guard after failure", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "prop-1" });
    const evaluated = toEvaluated(catalog);
    const beforePromotion = catalog.snapshot();
    const reentrantPromotionDecision = {
      get actor() {
        catalog.promote("prop-1", boundEvidence(evaluated), humanDecision());
        return "outer-operator";
      },
      reason: "Attempt nested promotion",
      decidedAt: "2026-08-11T01:03:00.000Z",
    };

    expect(() =>
      catalog.promote("prop-1", boundEvidence(evaluated), reentrantPromotionDecision),
    ).toThrow(/mutation is already in progress/i);
    expect(catalog.snapshot()).toEqual(beforePromotion);

    catalog.promote("prop-1", boundEvidence(evaluated), humanDecision());
    const beforeRollback = catalog.snapshot();
    const reentrantRollbackDecision = {
      get actor() {
        catalog.rollback(
          "prop-1",
          humanDecision({
            reason: "Nested rollback",
            decidedAt: "2026-08-11T01:04:00.000Z",
          }),
        );
        return "outer-operator";
      },
      reason: "Attempt nested rollback",
      decidedAt: "2026-08-11T01:04:00.000Z",
    };

    expect(() => catalog.rollback("prop-1", reentrantRollbackDecision)).toThrow(
      /mutation is already in progress/i,
    );
    expect(catalog.snapshot()).toEqual(beforeRollback);

    catalog.rollback(
      "prop-1",
      humanDecision({
        reason: "Rollback after guard release",
        decidedAt: "2026-08-11T01:04:00.000Z",
      }),
    );
    expect(catalog.snapshot().auditRecords.map((record) => record.kind)).toEqual([
      "promotion",
      "rollback",
    ]);
  });

  it("snapshots trust so later caller mutation cannot broaden proposal authority", () => {
    const mutableTrust: {
      configuredRolePromptPaths: string[];
      roleAllowedProfiles: Record<string, string[]>;
    } = {
      configuredRolePromptPaths: ["prompts/worker.md"],
      roleAllowedProfiles: { worker: ["codex-worker"] },
    };
    const catalog = createEvolutionCatalog(mutableTrust);

    mutableTrust.configuredRolePromptPaths.push("prompts/late-added.md");
    mutableTrust.roleAllowedProfiles.reviewer = ["codex-planner"];

    expect(() =>
      propose(catalog, {
        id: "late-prompt",
        policy: validPolicy({ allowedPromptPaths: ["prompts/late-added.md"] }),
        candidate: validPromptCandidate({ path: "prompts/late-added.md" }),
      }),
    ).toThrow(/configured role promptFile/i);
    expect(() =>
      propose(catalog, {
        id: "late-role",
        policy: validPolicy({ allowedPromptPaths: [] }),
        candidate: validStrategyCandidate({
          definition: {
            topology: { mode: "sequential" },
            maxParallel: 1,
            roleProfiles: { reviewer: "codex-planner" },
            approvalGates: ["final"],
          },
        }),
      }),
    ).toThrow(/unknown role/i);
    expect(catalog.snapshot().proposals).toEqual([]);
  });

  it("keeps malformed evaluation and rejection failures atomic", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "prop-1" });
    catalog.beginEvaluation("prop-1", "2026-08-11T01:01:00.000Z");
    const beforeEvaluation = catalog.snapshot();

    expect(() =>
      catalog.evaluate(
        "prop-1",
        { proposalId: "prop-1", candidateDigest: "bad", items: [] },
        "2026-08-11T01:02:00.000Z",
      ),
    ).toThrow(EvolutionValidationError);
    expect(catalog.snapshot()).toEqual(beforeEvaluation);

    const evaluating = catalog.getProposal("prop-1")!;
    catalog.evaluate(
      "prop-1",
      boundEvidence(evaluating),
      "2026-08-11T01:02:00.000Z",
    );
    const beforeRejection = catalog.snapshot();
    expect(() =>
      catalog.reject("prop-1", {
        actor: "",
        reason: "Invalid human decision",
        decidedAt: "2026-08-11T01:03:00.000Z",
      }),
    ).toThrow(EvolutionValidationError);
    expect(catalog.snapshot()).toEqual(beforeRejection);
  });

  it("restores a prior active role-prompt proposal after replacement rollback", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "prompt-a", candidate: validPromptCandidate() });
    const evaluatedA = toEvaluated(catalog, "prompt-a");
    catalog.promote("prompt-a", boundEvidence(evaluatedA), humanDecision());

    propose(catalog, {
      id: "prompt-b",
      createdAt: "2026-08-11T02:00:00.000Z",
      candidate: validPromptCandidate({ contentDigest: "b".repeat(64) }),
    });
    const evaluatedB = toEvaluated(catalog, "prompt-b");
    const { record: promotionB } = catalog.promote(
      "prompt-b",
      boundEvidence(evaluatedB),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );
    expect(promotionB.previousActiveProposalId).toBe("prompt-a");

    const { record: rollbackB } = catalog.rollback(
      "prompt-b",
      humanDecision({
        reason: "Restore prior prompt",
        decidedAt: "2026-08-11T02:04:00.000Z",
      }),
    );
    expect(rollbackB.restoredActiveProposalId).toBe("prompt-a");
    expect(catalog.getActiveProposalId({ kind: "role-prompt", path: "prompts/worker.md" })).toBe(
      "prompt-a",
    );
    expect(catalog.getProposal("prompt-a")?.status).toBe("promoted");
  });
});

describe("EvolutionCatalog trusted restore", () => {
  it("revalidates trust and terminal provenance instead of accepting caller claims", () => {
    const catalog = createCatalog();
    propose(catalog, { id: "prop-restore" });
    const evaluated = toEvaluated(catalog, "prop-restore");
    catalog.promote("prop-restore", boundEvidence(evaluated), humanDecision());
    const material = catalog.exportDurableMaterial();

    const restored = restoreEvolutionCatalog(defaultTrust, material);
    expect(restored.snapshot()).toEqual(catalog.snapshot());

    const missingAudit = { ...material, auditRecords: [] };
    expect(() => restoreEvolutionCatalog(defaultTrust, missingAudit)).toThrow(/audit/i);

    const forgedPromotion = structuredClone(material);
    Reflect.set(forgedPromotion.promotionRecords[0]!, "actor", "attacker");
    expect(() => restoreEvolutionCatalog(defaultTrust, forgedPromotion)).toThrow(
      /immutable promotion digest/i,
    );

    const forgedActive = structuredClone(material);
    Reflect.set(forgedActive.activeProposals[0]!, "proposalId", "missing-proposal");
    expect(() => restoreEvolutionCatalog(defaultTrust, forgedActive)).toThrow(/active pointer/i);

    const promptCatalog = createCatalog();
    propose(promptCatalog, { id: "prompt-forge", candidate: validPromptCandidate() });
    const forged = structuredClone(promptCatalog.exportDurableMaterial());
    const proposal = forged.proposals[0]!;
    Reflect.set(proposal.policy, "allowedPromptPaths", ["prompts/not-configured.md"]);
    if (proposal.candidate.kind !== "role-prompt") throw new Error("expected prompt candidate");
    Reflect.set(proposal.candidate, "path", "prompts/not-configured.md");
    expect(() => restoreEvolutionCatalog(defaultTrust, forged)).toThrow(EvolutionValidationError);

    const historyCatalog = createCatalog();
    propose(historyCatalog, { id: "history-old" });
    const oldEvaluated = toEvaluated(historyCatalog, "history-old");
    historyCatalog.promote(
      "history-old",
      boundEvidence(oldEvaluated),
      humanDecision({ decidedAt: "2026-08-11T01:03:00.000Z" }),
    );
    propose(historyCatalog, {
      id: "history-new",
      createdAt: "2026-08-11T02:00:00.000Z",
    });
    const newEvaluated = toEvaluated(historyCatalog, "history-new");
    historyCatalog.promote(
      "history-new",
      boundEvidence(newEvaluated),
      humanDecision({ decidedAt: "2026-08-11T02:03:00.000Z" }),
    );
    historyCatalog.rollback(
      "history-new",
      humanDecision({
        reason: "Restore the previous proposal",
        decidedAt: "2026-08-11T02:04:00.000Z",
      }),
    );
    const history = historyCatalog.exportDurableMaterial();
    const reorderedAudit = {
      ...history,
      auditRecords: [history.auditRecords[2]!, history.auditRecords[0]!, history.auditRecords[1]!],
    };
    expect(() => restoreEvolutionCatalog(defaultTrust, reorderedAudit)).toThrow(/out of order/i);
  });
});

describe("EvolutionCatalog error taxonomy", () => {
  it("surfaces domain and catalog errors distinctly", () => {
    const catalog = createCatalog();
    expect(() => catalog.getProposal("missing")).not.toThrow();
    expect(catalog.getProposal("missing")).toBeUndefined();

    expect(() => catalog.beginEvaluation("missing", now)).toThrow(EvolutionCatalogNotFoundError);
    expect(() => catalog.beginEvaluation("missing", now)).toThrow(EvolutionCatalogError);

    propose(catalog, { id: "dup" });
    expect(() => propose(catalog, { id: "dup" })).toThrow(EvolutionCatalogConflictError);
  });
});
