import { describe, expect, it } from "vitest";
import {
  assertLifecycleTransition,
  assertPromotionAllowed,
  assertPromotionRecordMatchesProposal,
  assertSafePromptPath,
  computeCandidateDigest,
  computeEvaluationResult,
  createEvolutionProposal,
  createEvolutionTrustContext,
  describeUnsafePath,
  evaluateProposal,
  evolutionCapabilitiesSchema,
  evolutionCandidateSchema,
  evolutionLifecycleStatuses,
  evolutionLifecycleTransitions,
  evolutionPolicySchema,
  evolutionProposalSchema,
  isAllowedLifecycleTransition,
  parseEvolutionCandidate,
  parseEvolutionEvidence,
  parseEvolutionPolicy,
  parseEvolutionProposal,
  parseHumanDecision,
  parsePromotionRecord,
  promoteProposal,
  rejectProposal,
  rollbackProposal,
  rolePromptCandidateSchema,
  transitionProposal,
  type EvolutionProposal,
  type EvolutionTrustContext,
  EvolutionLifecycleError,
  EvolutionPromotionError,
  EvolutionValidationError,
} from "../src/evolution/domain.js";
import { namedStrategySchema } from "../src/config/schema.js";

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

function createProposed(candidate: unknown = validStrategyCandidate()): EvolutionProposal {
  return createEvolutionProposal({
    id: "prop-1",
    createdAt: now,
    policy: validPolicy(),
    candidate,
    trust: defaultTrust,
  });
}

function toEvaluating(proposal: EvolutionProposal = createProposed()): EvolutionProposal {
  return transitionProposal(proposal, "evaluating", "2026-08-11T01:01:00.000Z");
}

function boundEvidence(
  proposal: EvolutionProposal,
  items: Array<Record<string, unknown>> = [
    {
      kind: "deterministic",
      id: "unit-tests",
      status: "pass",
      summary: "Focused domain tests passed",
    },
    {
      kind: "advisory",
      id: "reviewer",
      verdict: "approve",
      summary: "Looks good",
    },
  ],
) {
  return {
    proposalId: proposal.id,
    candidateDigest: computeCandidateDigest(proposal.candidate),
    items,
  };
}

function toEvaluated(
  proposal: EvolutionProposal = toEvaluating(),
  items?: Array<Record<string, unknown>>,
): EvolutionProposal {
  return evaluateProposal(proposal, boundEvidence(proposal, items), "2026-08-11T01:02:00.000Z");
}

function humanDecision(overrides: Record<string, unknown> = {}) {
  return {
    actor: "operator",
    reason: "Promote after review",
    decidedAt: "2026-08-11T02:00:00.000Z",
    ...overrides,
  };
}

describe("evolution policy and schema validation", () => {
  it("accepts a versioned policy with all capabilities forced false", () => {
    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    expect(policy.version).toBe(1);
    expect(policy.capabilities).toEqual({
      automaticExecution: false,
      automaticPromotion: false,
      networkPublication: false,
      secretStorage: false,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects capability flags that are not literal false", () => {
    for (const key of [
      "automaticExecution",
      "automaticPromotion",
      "networkPublication",
      "secretStorage",
    ] as const) {
      expect(() =>
        parseEvolutionPolicy(
          validPolicy({
            capabilities: {
              automaticExecution: false,
              automaticPromotion: false,
              networkPublication: false,
              secretStorage: false,
              [key]: true,
            },
          }),
          defaultTrust,
        ),
      ).toThrow(EvolutionValidationError);
    }
    expect(
      evolutionCapabilitiesSchema.safeParse({
        automaticExecution: false,
        automaticPromotion: false,
        networkPublication: false,
        secretStorage: false,
        extra: false,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields, invalid strategy names, and nested unknown fields", () => {
    expect(() => parseEvolutionPolicy({ ...validPolicy(), unexpected: true }, defaultTrust)).toThrow(
      EvolutionValidationError,
    );
    // Empty prompt allowlist is valid (strategy-only evolution).
    expect(() => parseEvolutionPolicy(validPolicy({ allowedPromptPaths: [] }), defaultTrust)).not.toThrow();
    expect(() =>
      parseEvolutionCandidate(
        validStrategyCandidate({ name: "bad/name" }),
        parseEvolutionPolicy(validPolicy(), defaultTrust),
        defaultTrust,
      ),
    ).toThrow(EvolutionValidationError);
    expect(() =>
      parseEvolutionCandidate(
        validStrategyCandidate({
          definition: { roleProfiles: {}, approvalGates: ["plan"] },
        }),
        parseEvolutionPolicy(validPolicy(), defaultTrust),
        defaultTrust,
      ),
    ).toThrow(EvolutionValidationError);

    expect(() =>
      createEvolutionProposal({
        id: "prop-x",
        createdAt: now,
        policy: validPolicy(),
        candidate: validStrategyCandidate({
          definition: {
            topology: { mode: "sequential", unexpected: true },
            maxParallel: 1,
            roleProfiles: {},
            approvalGates: ["final"],
          },
        }),
        trust: defaultTrust,
      }),
    ).toThrow(EvolutionValidationError);

    expect(() =>
      createEvolutionProposal({
        id: "prop-x",
        createdAt: now,
        policy: { ...validPolicy(), extraPolicyField: 1 },
        candidate: validStrategyCandidate(),
        trust: defaultTrust,
      }),
    ).toThrow(EvolutionValidationError);
  });

  it("rejects credential, environment, and raw-output payloads", () => {
    expect(() =>
      parseEvolutionPolicy(
        {
          ...validPolicy(),
          secret: "x",
        },
        defaultTrust,
      ),
    ).toThrow(/secret|Credential|environment|raw-output/i);
    expect(() =>
      parseEvolutionEvidence({
        proposalId: "prop-1",
        candidateDigest: "a".repeat(64),
        items: [
          {
            kind: "deterministic",
            id: "x",
            status: "pass",
            summary: "ok",
            stdout: "leak",
          },
        ],
      }),
    ).toThrow(EvolutionValidationError);
    expect(() =>
      parseHumanDecision({
        ...humanDecision(),
        env: { TOKEN: "x" },
      }),
    ).toThrow(EvolutionValidationError);
  });

  it("derives prompt allowlists from configured role promptFile targets", () => {
    expect(() =>
      parseEvolutionPolicy(
        validPolicy({ allowedPromptPaths: ["README.md", "prompts/worker.md"] }),
        defaultTrust,
      ),
    ).toThrow(/not a configured role promptFile/i);

    expect(() =>
      parseEvolutionPolicy(
        validPolicy({ allowedPromptPaths: ["prompts/unconfigured.md"] }),
        defaultTrust,
      ),
    ).toThrow(/not a configured role promptFile/i);

    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    expect(() =>
      parseEvolutionCandidate(validPromptCandidate({ path: "README.md" }), policy, defaultTrust),
    ).toThrow(EvolutionValidationError);
  });

  it("rejects strategy candidates with unknown roles or disallowed profiles", () => {
    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    expect(() =>
      parseEvolutionCandidate(
        validStrategyCandidate({
          definition: {
            topology: { mode: "sequential" },
            maxParallel: 1,
            roleProfiles: { "not-a-role": "codex-planner" },
            approvalGates: ["final"],
          },
        }),
        policy,
        defaultTrust,
      ),
    ).toThrow(/Unknown role/);

    expect(() =>
      parseEvolutionCandidate(
        validStrategyCandidate({
          definition: {
            topology: { mode: "sequential" },
            maxParallel: 1,
            roleProfiles: { reviewer: "codex-worker" },
            approvalGates: ["final"],
          },
        }),
        policy,
        defaultTrust,
      ),
    ).toThrow(/not allowed for role 'reviewer'/);

    expect(() =>
      parseEvolutionCandidate(
        validStrategyCandidate({
          definition: {
            topology: { mode: "sequential" },
            maxParallel: 1,
            roleProfiles: { toString: "codex-planner" },
            approvalGates: ["final"],
          },
        }),
        policy,
        defaultTrust,
      ),
    ).toThrow(EvolutionValidationError);

    const prototypeRoleCandidate = validStrategyCandidate({
      definition: {
        topology: { mode: "sequential" },
        maxParallel: 1,
        roleProfiles: JSON.parse('{"__proto__":"codex-planner"}'),
        approvalGates: ["final"],
      },
    });
    expect(() =>
      parseEvolutionCandidate(prototypeRoleCandidate, policy, defaultTrust),
    ).toThrow(/prototype|__proto__/i);

    expect(() =>
      createEvolutionTrustContext(
        JSON.parse(
          '{"roles":{"__proto__":{"allowedProfiles":["codex-planner"]}}}',
        ),
      ),
    ).toThrow(/prototype|__proto__/i);
  });

  it("rejects negative zero before candidate digest canonicalization", () => {
    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    const accepted = parseEvolutionCandidate(
      validStrategyCandidate({
        definition: {
          topology: { mode: "sequential" },
          maxParallel: 1,
          maxReworkAttempts: 0,
          roleProfiles: {},
          approvalGates: ["final"],
        },
      }),
      policy,
      defaultTrust,
    );
    expect(accepted.kind).toBe("strategy-blueprint");

    const negativeZero = JSON.parse("-0") as number;
    expect(Object.is(negativeZero, -0)).toBe(true);
    expect(() =>
      parseEvolutionCandidate(
        validStrategyCandidate({
          definition: {
            topology: { mode: "sequential" },
            maxParallel: 1,
            maxReworkAttempts: negativeZero,
            roleProfiles: {},
            approvalGates: ["final"],
          },
        }),
        policy,
        defaultTrust,
      ),
    ).toThrow(/negative zero/i);
  });
});

describe("mutation surface path validation", () => {
  it("accepts allowlisted repository-relative Markdown prompt paths with digests", () => {
    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    const candidate = parseEvolutionCandidate(validPromptCandidate(), policy, defaultTrust);
    expect(candidate).toMatchObject({
      kind: "role-prompt",
      path: "prompts/worker.md",
      contentDigest: "a".repeat(64),
    });
    expect(assertSafePromptPath("prompts/reviewer.md", policy.allowedPromptPaths)).toBe(
      "prompts/reviewer.md",
    );
  });

  it("never stores raw prompt contents and rejects non-allowlisted or source targets", () => {
    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    expect(() =>
      parseEvolutionCandidate(
        {
          kind: "role-prompt",
          path: "prompts/worker.md",
          contentDigest: "a".repeat(64),
          content: "system prompt body",
        },
        policy,
        defaultTrust,
      ),
    ).toThrow(EvolutionValidationError);

    expect(() =>
      parseEvolutionCandidate(validPromptCandidate({ path: "prompts/architect.md" }), policy, defaultTrust),
    ).toThrow(/not allowlisted/);

    const rejected = [
      "/etc/passwd",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "C:/Windows/System32/drivers/etc/hosts",
      "../prompts/worker.md",
      "prompts/../../etc/passwd",
      "prompts/./worker.md",
      "src/evolution/domain.ts",
      "src/cli.ts",
      "web/src/main.tsx",
      "package.json",
      "agent-team.yaml",
      "prompts/worker.ts",
    ];
    for (const pathValue of rejected) {
      expect(describeUnsafePath(pathValue, { requireMarkdown: true })).toBeTypeOf("string");
      expect(() => assertSafePromptPath(pathValue, policy.allowedPromptPaths)).toThrow(
        EvolutionValidationError,
      );
    }
  });
});

describe("proposal immutability and lifecycle transitions", () => {
  it("creates an immutable proposed proposal with a policy snapshot", () => {
    const created = createProposed();
    expect(created.status).toBe("proposed");
    expect(created.transitions).toEqual([]);
    expect(created.evaluation).toBeUndefined();
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.policy)).toBe(true);
    expect(Object.isFrozen(created.candidate)).toBe(true);
    expect(() => {
      (created as { status: string }).status = "promoted";
    }).toThrow();
  });

  it("permits only the documented transition matrix", () => {
    const allowed = new Set(
      evolutionLifecycleTransitions.map(([from, to]) => `${from}->${to}`),
    );
    expect([...allowed].sort()).toEqual(
      [
        "proposed->evaluating",
        "evaluating->evaluated",
        "evaluated->promoted",
        "evaluated->rejected",
        "promoted->rolled-back",
      ].sort(),
    );

    for (const from of evolutionLifecycleStatuses) {
      for (const to of evolutionLifecycleStatuses) {
        const ok = isAllowedLifecycleTransition(from, to);
        expect(ok).toBe(allowed.has(`${from}->${to}`));
        if (!ok) {
          expect(() => assertLifecycleTransition(from, to)).toThrow(EvolutionLifecycleError);
        }
      }
    }
  });

  it("rejects direct promotion and rollback via generic transitionProposal", () => {
    const evaluating = toEvaluating();
    expect(() => transitionProposal(evaluating, "evaluated", "2026-08-11T01:02:00.000Z")).toThrow(
      /guarded operation/,
    );

    const evaluated = toEvaluated();
    expect(() => transitionProposal(evaluated, "promoted", "2026-08-11T01:03:00.000Z")).toThrow(
      /guarded operation/,
    );
    expect(() => transitionProposal(evaluated, "rejected", "2026-08-11T01:03:00.000Z")).toThrow(
      /guarded operation/,
    );

    const { proposal: promoted } = promoteProposal({
      proposal: evaluated,
      evidence: boundEvidence(evaluated),
      decision: humanDecision(),
    });
    expect(() => transitionProposal(promoted, "rolled-back", "2026-08-11T01:04:00.000Z")).toThrow(
      /guarded operation/,
    );
  });

  it("appends transitions without mutating the prior proposal", () => {
    const proposed = createProposed();
    const evaluating = transitionProposal(proposed, "evaluating", "2026-08-11T01:01:00.000Z");
    expect(proposed.status).toBe("proposed");
    expect(proposed.transitions).toHaveLength(0);
    expect(evaluating.status).toBe("evaluating");
    expect(evaluating.transitions).toEqual([
      {
        from: "proposed",
        to: "evaluating",
        at: "2026-08-11T01:01:00.000Z",
      },
    ]);
    expect(() => transitionProposal(evaluating, "promoted", "2026-08-11T01:02:00.000Z")).toThrow(
      EvolutionLifecycleError,
    );

    const evaluated = evaluateProposal(
      evaluating,
      boundEvidence(evaluating),
      "2026-08-11T01:02:00.000Z",
    );
    expect(evaluated.status).toBe("evaluated");
    expect(evaluated.evaluation).toBeDefined();

    const { proposal: promoted, record: promotion } = promoteProposal({
      proposal: evaluated,
      evidence: boundEvidence(evaluated),
      decision: humanDecision({ decidedAt: "2026-08-11T01:03:00.000Z" }),
    });
    const { proposal: rolledBack } = rollbackProposal({
      proposal: promoted,
      promotionRecord: promotion,
      decision: humanDecision({
        reason: "Restore prior pointer",
        decidedAt: "2026-08-11T01:04:00.000Z",
      }),
    });
    expect(rolledBack.transitions.map((item) => `${item.from}->${item.to}`)).toEqual([
      "proposed->evaluating",
      "evaluating->evaluated",
      "evaluated->promoted",
      "promoted->rolled-back",
    ]);

    const { proposal: rejected } = rejectProposal({
      proposal: evaluated,
      decision: humanDecision({
        reason: "Not ready",
        decidedAt: "2026-08-11T01:05:00.000Z",
      }),
    });
    expect(rejected.status).toBe("rejected");
    expect(() =>
      promoteProposal({
        proposal: rejected,
        evidence: boundEvidence(rejected),
        decision: humanDecision({ decidedAt: "2026-08-11T01:06:00.000Z" }),
      }),
    ).toThrow(EvolutionPromotionError);
  });
});

describe("evidence computation and promotion guards", () => {
  it("requires deterministic evidence and lets deterministic failures veto advisory approvals", () => {
    const evaluating = toEvaluating();
    const digest = computeCandidateDigest(evaluating.candidate);

    expect(() =>
      computeEvaluationResult({
        proposalId: evaluating.id,
        candidateDigest: digest,
        items: [
          {
            kind: "advisory",
            id: "reviewer",
            verdict: "approve",
            summary: "looks fine",
          },
        ],
      }),
    ).toThrow(/deterministic/i);

    const failed = computeEvaluationResult({
      proposalId: evaluating.id,
      candidateDigest: digest,
      items: [
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
          summary: "approve anyway",
        },
      ],
    });
    expect(failed.passed).toBe(false);
    expect(failed.deterministicPassed).toBe(false);
    expect(failed.advisoryPassed).toBe(false);
    expect(failed.failedDeterministicIds).toEqual(["unit-tests"]);
    expect(failed.proposalId).toBe("prop-1");
    expect(failed.candidateDigest).toBe(digest);

    const passed = computeEvaluationResult(boundEvidence(evaluating));
    expect(passed.passed).toBe(true);
    expect(passed.deterministicPassed).toBe(true);
    expect(passed.advisoryPassed).toBe(true);
  });

  it("rejects fabricated evaluation results and cross-proposal evidence reuse", () => {
    const evaluated = toEvaluated();
    const decision = parseHumanDecision(humanDecision());

    // Fabricated result with inconsistent booleans is not accepted; promotion uses evidence.
    expect(() =>
      assertPromotionAllowed({
        proposal: evaluated,
        evidence: {
          proposalId: evaluated.id,
          candidateDigest: computeCandidateDigest(evaluated.candidate),
          items: [
            {
              kind: "deterministic",
              id: "unit-tests",
              status: "fail",
              summary: "fail",
            },
            {
              kind: "advisory",
              id: "reviewer",
              verdict: "request_changes",
              summary: "needs work",
            },
          ],
        },
        decision,
      }),
    ).toThrow(EvolutionPromotionError);

    // Evidence from another proposal cannot be used.
    const other = createEvolutionProposal({
      id: "prop-2",
      createdAt: now,
      policy: validPolicy(),
      candidate: validStrategyCandidate({ name: "other-strategy" }),
      trust: defaultTrust,
    });
    const otherEvaluating = toEvaluating(other);
    const otherEvaluated = toEvaluated(otherEvaluating);
    expect(() =>
      promoteProposal({
        proposal: evaluated,
        evidence: boundEvidence(otherEvaluated),
        decision: humanDecision(),
      }),
    ).toThrow(/bound to proposal|does not match/i);

    // Evidence with wrong candidate digest is rejected.
    expect(() =>
      promoteProposal({
        proposal: evaluated,
        evidence: {
          ...boundEvidence(evaluated),
          candidateDigest: "b".repeat(64),
        },
        decision: humanDecision(),
      }),
    ).toThrow(/candidate digest/i);
  });

  it("requires evaluated status, bound evidence, and attributed human decision for promotion", () => {
    const decision = parseHumanDecision(humanDecision());
    const proposed = createProposed();

    expect(() =>
      assertPromotionAllowed({
        proposal: proposed,
        evidence: boundEvidence(proposed),
        decision,
      }),
    ).toThrow(EvolutionPromotionError);

    const failedEvaluated = toEvaluated(toEvaluating(), [
      {
        kind: "deterministic",
        id: "unit-tests",
        status: "fail",
        summary: "fail",
      },
    ]);
    expect(() =>
      assertPromotionAllowed({
        proposal: failedEvaluated,
        evidence: boundEvidence(failedEvaluated, [
          {
            kind: "deterministic",
            id: "unit-tests",
            status: "fail",
            summary: "fail",
          },
        ]),
        decision,
      }),
    ).toThrow(EvolutionPromotionError);

    expect(() =>
      parseHumanDecision({
        actor: "   ",
        reason: "because",
        decidedAt: decision.decidedAt,
      }),
    ).toThrow(EvolutionValidationError);

    expect(() =>
      parseHumanDecision({
        actor: "operator",
        reason: "",
        decidedAt: decision.decidedAt,
      }),
    ).toThrow(EvolutionValidationError);

    const evaluated = toEvaluated();
    const { proposal: promoted, record: promotion } = promoteProposal({
      proposal: evaluated,
      evidence: boundEvidence(evaluated),
      decision: humanDecision(),
      previousActiveProposalId: null,
    });
    expect(promoted.status).toBe("promoted");
    expect(promotion).toMatchObject({
      kind: "promotion",
      proposalId: "prop-1",
      actor: "operator",
      reason: "Promote after review",
      previousActiveProposalId: null,
    });
    expect(Object.isFrozen(promotion)).toBe(true);

    const { proposal: rejected, record: rejection } = rejectProposal({
      proposal: evaluated,
      decision: humanDecision({ reason: "Not ready", decidedAt: "2026-08-11T02:01:00.000Z" }),
    });
    expect(rejected.status).toBe("rejected");
    expect(rejection.kind).toBe("rejection");

    const { proposal: rolledBack, record: rollback } = rollbackProposal({
      proposal: promoted,
      promotionRecord: promotion,
      decision: humanDecision({
        reason: "Restore prior pointer",
        decidedAt: "2026-08-11T02:02:00.000Z",
      }),
    });
    expect(rolledBack.status).toBe("rolled-back");
    expect(rollback).toMatchObject({
      kind: "rollback",
      restoredActiveProposalId: null,
    });

    expect(() =>
      rollbackProposal({
        proposal: evaluated,
        promotionRecord: promotion,
        decision: humanDecision(),
      }),
    ).toThrow(EvolutionLifecycleError);
  });
});

describe("proposal history and corruption rejection", () => {
  it("requires evidence to enter evaluated and rejects corrupted transition histories", () => {
    const evaluating = toEvaluating();
    expect(evaluating.evaluation).toBeUndefined();
    expect(() =>
      evaluateProposal(
        evaluating,
        {
          proposalId: evaluating.id,
          candidateDigest: computeCandidateDigest(evaluating.candidate),
          items: [
            {
              kind: "advisory",
              id: "reviewer",
              verdict: "approve",
              summary: "approve only",
            },
          ],
        },
        "2026-08-11T01:02:00.000Z",
      ),
    ).toThrow(/deterministic/i);

    const base = createProposed();
    const digest = computeCandidateDigest(base.candidate);
    const passingEvidence = {
      proposalId: base.id,
      candidateDigest: digest,
      items: [
        {
          kind: "deterministic",
          id: "unit-tests",
          status: "pass",
          summary: "ok",
        },
      ],
    };
    const passingResult = computeEvaluationResult(passingEvidence);

    // Promoted with no transitions.
    expect(
      evolutionProposalSchema.safeParse({
        ...base,
        status: "promoted",
        transitions: [],
        evaluation: {
          evidence: passingEvidence,
          result: passingResult,
          at: "2026-08-11T01:02:00.000Z",
        },
      }).success,
    ).toBe(false);

    // Disconnected transitions.
    expect(
      evolutionProposalSchema.safeParse({
        ...base,
        status: "evaluated",
        transitions: [
          { from: "proposed", to: "evaluating", at: "2026-08-11T01:01:00.000Z" },
          { from: "evaluated", to: "promoted", at: "2026-08-11T01:03:00.000Z" },
        ],
        evaluation: {
          evidence: passingEvidence,
          result: passingResult,
          at: "2026-08-11T01:02:00.000Z",
        },
      }).success,
    ).toBe(false);

    // Final transition inconsistent with status.
    expect(
      evolutionProposalSchema.safeParse({
        ...base,
        status: "promoted",
        transitions: [
          { from: "proposed", to: "evaluating", at: "2026-08-11T01:01:00.000Z" },
          { from: "evaluating", to: "evaluated", at: "2026-08-11T01:02:00.000Z" },
        ],
        evaluation: {
          evidence: passingEvidence,
          result: passingResult,
          at: "2026-08-11T01:02:00.000Z",
        },
      }).success,
    ).toBe(false);

    // Timestamp preceding creation.
    expect(
      evolutionProposalSchema.safeParse({
        ...base,
        status: "evaluating",
        transitions: [
          { from: "proposed", to: "evaluating", at: "2026-08-10T00:00:00.000Z" },
        ],
      }).success,
    ).toBe(false);

    // Evaluated without evidence.
    expect(
      evolutionProposalSchema.safeParse({
        ...base,
        status: "evaluated",
        transitions: [
          { from: "proposed", to: "evaluating", at: "2026-08-11T01:01:00.000Z" },
          { from: "evaluating", to: "evaluated", at: "2026-08-11T01:02:00.000Z" },
        ],
      }).success,
    ).toBe(false);

    // parseEvolutionProposal rejects the same corruption.
    expect(() =>
      parseEvolutionProposal(
        {
          ...base,
          status: "promoted",
          transitions: [],
        },
        defaultTrust,
      ),
    ).toThrow(EvolutionValidationError);
  });
});

describe("policy schema surface", () => {
  it("exposes the phase-1 policy schema for durable catalog consumers", () => {
    expect(evolutionPolicySchema.safeParse(validPolicy()).success).toBe(true);
    expect(
      evolutionPolicySchema.safeParse(
        validPolicy({
          capabilities: {
            automaticExecution: false,
            automaticPromotion: true,
            networkPublication: false,
            secretStorage: false,
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("persisted proposal and audit reopen validation", () => {
  it("permits strategy-only trust contexts with an empty prompt allowlist", () => {
    const strategyOnlyTrust = createEvolutionTrustContext({
      roles: {
        orchestrator: { allowedProfiles: ["codex-planner"] },
        architect: { allowedProfiles: ["codex-planner"] },
        worker: { allowedProfiles: ["codex-worker"] },
        reviewer: { allowedProfiles: ["codex-planner"] },
        tester: { allowedProfiles: ["codex-planner"] },
      },
    });
    expect(strategyOnlyTrust.configuredRolePromptPaths).toEqual([]);
    const policy = parseEvolutionPolicy(
      {
        version: 1,
        capabilities: {
          automaticExecution: false,
          automaticPromotion: false,
          networkPublication: false,
          secretStorage: false,
        },
        allowedPromptPaths: [],
      },
      strategyOnlyTrust,
    );
    expect(policy.allowedPromptPaths).toEqual([]);
    const proposal = createEvolutionProposal({
      id: "prop-strategy-only",
      createdAt: now,
      policy,
      candidate: validStrategyCandidate(),
      trust: strategyOnlyTrust,
    });
    expect(proposal.candidate.kind).toBe("strategy-blueprint");
    expect(parseEvolutionProposal(proposal, strategyOnlyTrust).id).toBe("prop-strategy-only");
  });

  it("rejects absolute, traversal, source-code, and non-allowlisted paths on public candidate schemas", () => {
    const unsafePaths = [
      "../../outside.md",
      "../../src/index.ts",
      "/etc/passwd",
      "C:/Windows/System32/drivers/etc/hosts",
      "src/index.ts",
      "prompts/not-allowlisted.md",
    ];
    for (const pathValue of unsafePaths) {
      const parsed = rolePromptCandidateSchema.safeParse({
        kind: "role-prompt",
        path: pathValue,
        contentDigest: "a".repeat(64),
      });
      // Source and traversal are rejected by the path schema itself.
      // Non-allowlisted Markdown still needs policy/trust context (schema may accept shape).
      if (
        pathValue.endsWith(".md") &&
        !pathValue.includes("..") &&
        !pathValue.startsWith("/") &&
        !/^[A-Za-z]:/.test(pathValue)
      ) {
        // Shape-valid Markdown still fails candidate/policy relationship when parsed with policy.
        expect(parsed.success).toBe(true);
      } else {
        expect(parsed.success).toBe(false);
      }

      expect(
        evolutionCandidateSchema.safeParse({
          kind: "role-prompt",
          path: pathValue,
          contentDigest: "a".repeat(64),
        }).success,
      ).toBe(parsed.success);
    }

    // Non-allowlisted but otherwise safe Markdown is rejected with policy.
    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    expect(() =>
      parseEvolutionCandidate(
        {
          kind: "role-prompt",
          path: "prompts/not-allowlisted.md",
          contentDigest: "a".repeat(64),
        },
        policy,
        defaultTrust,
      ),
    ).toThrow(/not allowlisted|not a configured/i);
  });

  it("rejects forged role-prompt paths when reopening persisted proposals with trust", () => {
    const base = createProposed(validPromptCandidate());
    const forgedPaths = [
      "../../outside.md",
      "../../src/index.ts",
      "src/index.ts",
      "prompts/unconfigured.md",
      "/tmp/evil.md",
    ];
    for (const pathValue of forgedPaths) {
      const forged = {
        ...structuredClone(base),
        candidate: {
          kind: "role-prompt",
          path: pathValue,
          contentDigest: "a".repeat(64),
        },
      };
      // Schema-level path safety rejects absolute/traversal/source without trust.
      expect(evolutionProposalSchema.safeParse(forged).success).toBe(false);
      // Trust-aware reopen also rejects non-allowlisted configured-looking paths.
      expect(() => parseEvolutionProposal(forged, defaultTrust)).toThrow(EvolutionValidationError);
    }

    // Candidate path not in the proposal policy allowlist but otherwise safe.
    const allowlistBypass = {
      ...structuredClone(base),
      policy: {
        ...base.policy,
        allowedPromptPaths: ["prompts/reviewer.md"],
      },
      candidate: {
        kind: "role-prompt",
        path: "prompts/worker.md",
        contentDigest: "a".repeat(64),
      },
    };
    expect(evolutionProposalSchema.safeParse(allowlistBypass).success).toBe(false);
    expect(() => parseEvolutionProposal(allowlistBypass, defaultTrust)).toThrow(
      EvolutionValidationError,
    );

    const forgedPolicyAndCandidate = {
      ...structuredClone(base),
      policy: {
        ...base.policy,
        allowedPromptPaths: ["prompts/unconfigured.md"],
      },
      candidate: {
        kind: "role-prompt",
        path: "prompts/unconfigured.md",
        contentDigest: "a".repeat(64),
      },
    };
    expect(evolutionProposalSchema.safeParse(forgedPolicyAndCandidate).success).toBe(true);
    expect(() => parseEvolutionProposal(forgedPolicyAndCandidate, defaultTrust)).toThrow(
      /not a configured role promptFile/i,
    );
    expect(() =>
      parseEvolutionProposal(
        base,
        undefined as unknown as Parameters<typeof parseEvolutionProposal>[1],
      ),
    ).toThrow(/project-derived EvolutionTrustContext is required/i);

    const forgedStrategy = {
      ...structuredClone(createProposed()),
      candidate: validStrategyCandidate({
        definition: {
          topology: { mode: "sequential" },
          maxParallel: 1,
          roleProfiles: { reviewer: "codex-worker" },
          approvalGates: ["final"],
        },
      }),
    };
    expect(() => parseEvolutionProposal(forgedStrategy, defaultTrust)).toThrow(
      /not allowed for role 'reviewer'/i,
    );
  });

  it("checks strategy candidates for behavioral parity with namedStrategySchema", () => {
    const policy = parseEvolutionPolicy(validPolicy(), defaultTrust);
    const validDefinition = {
      topology: { mode: "sequential" },
      maxParallel: 1,
      roleProfiles: {},
      approvalGates: ["final"],
    };
    expect(namedStrategySchema.safeParse(validDefinition).success).toBe(true);
    expect(() =>
      parseEvolutionCandidate(
        validStrategyCandidate({ definition: validDefinition }),
        policy,
        defaultTrust,
      ),
    ).not.toThrow();

    const invalidCases = [
      { approvalGates: ["plan"] }, // missing final
      { maxParallel: 4 }, // sequential requires 1
      { approvalGates: ["final", "final"] }, // duplicates
    ];
    for (const partial of invalidCases) {
      const definition = {
        topology: { mode: "sequential" },
        maxParallel: 1,
        roleProfiles: {},
        approvalGates: ["final"],
        ...partial,
      };
      expect(namedStrategySchema.safeParse(definition).success).toBe(false);
      expect(() =>
        parseEvolutionCandidate(
          validStrategyCandidate({ definition }),
          policy,
          defaultTrust,
        ),
      ).toThrow(EvolutionValidationError);
    }
  });

  it("rejects promotion audit records with failed or mismatched evaluation bindings", () => {
    const evaluated = toEvaluated();
    const { proposal: promoted, record } = promoteProposal({
      proposal: evaluated,
      evidence: boundEvidence(evaluated),
      decision: humanDecision(),
      previousActiveProposalId: null,
    });
    expect(parsePromotionRecord(record)).toMatchObject({ kind: "promotion", proposalId: "prop-1" });
    expect(() => assertPromotionRecordMatchesProposal(record, promoted)).not.toThrow();

    // Failed evaluation cannot be stored as a promotion record.
    const failedResult = {
      ...record.evaluation,
      passed: false,
      deterministicPassed: false,
      failedDeterministicIds: ["unit-tests"],
      summary: "failed",
    };
    expect(() =>
      parsePromotionRecord({
        ...record,
        evaluation: failedResult,
      }),
    ).toThrow(EvolutionValidationError);
    expect(() =>
      parsePromotionRecord({
        ...record,
        evaluation: {
          ...record.evaluation,
          passed: true,
          deterministicPassed: true,
          advisoryPassed: false,
          failedDeterministicIds: [],
          advisoryVerdicts: [],
        },
      }),
    ).toThrow(/advisoryPassed|inconsistent/i);

    // Evaluation bound to another proposal id.
    expect(() =>
      parsePromotionRecord({
        ...record,
        evaluation: {
          ...record.evaluation,
          proposalId: "other-prop",
        },
      }),
    ).toThrow(/different proposal|Promotion evaluation/i);

    // Record proposalId mismatch vs proposal.
    expect(() =>
      assertPromotionRecordMatchesProposal(
        {
          ...record,
          proposalId: "other-prop",
          evaluation: {
            ...record.evaluation,
            proposalId: "other-prop",
          },
        },
        promoted,
      ),
    ).toThrow(/bound to/);

    // Evaluation result does not match the proposal snapshot.
    expect(() =>
      assertPromotionRecordMatchesProposal(
        {
          ...record,
          evaluation: {
            ...record.evaluation,
            summary: "tampered summary that still claims pass",
          },
        },
        promoted,
      ),
    ).toThrow(/does not match/i);
  });

  it("rejects promoted persistence with a failing recomputed evaluation", () => {
    const failedEvaluated = toEvaluated(toEvaluating(), [
      {
        kind: "deterministic",
        id: "unit-tests",
        status: "fail",
        summary: "tests failed",
      },
    ]);
    const forgedPromoted = {
      ...structuredClone(failedEvaluated),
      status: "promoted",
      transitions: [
        ...failedEvaluated.transitions,
        { from: "evaluated", to: "promoted", at: "2026-08-11T01:03:00.000Z" },
      ],
    };
    expect(() => parseEvolutionProposal(forgedPromoted, defaultTrust)).toThrow(
      /requires a passing evaluation/i,
    );

    const forgedRolledBack = {
      ...forgedPromoted,
      status: "rolled-back",
      transitions: [
        ...forgedPromoted.transitions,
        { from: "promoted", to: "rolled-back", at: "2026-08-11T01:04:00.000Z" },
      ],
    };
    expect(() => parseEvolutionProposal(forgedRolledBack, defaultTrust)).toThrow(
      /requires a passing evaluation/i,
    );
  });

  it("derives rollback restoration from a strict promotion record", () => {
    const evaluated = toEvaluated();
    const { proposal: promoted, record: promotion } = promoteProposal({
      proposal: evaluated,
      evidence: boundEvidence(evaluated),
      decision: humanDecision(),
      previousActiveProposalId: "prop-previous",
    });
    const { record: rollback } = rollbackProposal({
      proposal: promoted,
      promotionRecord: promotion,
      decision: humanDecision({
        reason: "Restore previous active proposal",
        decidedAt: "2026-08-11T02:02:00.000Z",
      }),
    });
    expect(rollback.restoredActiveProposalId).toBe("prop-previous");

    expect(() =>
      rollbackProposal({
        proposal: promoted,
        promotionRecord: {
          ...promotion,
          previousActiveProposalId: "prop-substituted",
        },
        decision: humanDecision({
          reason: "Attempt substituted restore",
          decidedAt: "2026-08-11T02:03:00.000Z",
        }),
      }),
    ).toThrow(/promotion digest/i);
    expect(() =>
      rollbackProposal({
        proposal: promoted,
        promotionRecord: {
          ...promotion,
          at: "2026-08-11T01:59:00.000Z",
        },
        decision: humanDecision({
          reason: "Attempt mismatched promotion time",
          decidedAt: "2026-08-11T02:03:00.000Z",
        }),
      }),
    ).toThrow(/timestamp does not match/i);

    for (const tamperedRecord of [
      { ...promotion, actor: "different-operator" },
      { ...promotion, reason: "Different promotion reason" },
    ]) {
      expect(() =>
        rollbackProposal({
          proposal: promoted,
          promotionRecord: tamperedRecord,
          decision: humanDecision({
            reason: "Attempt audit-field substitution",
            decidedAt: "2026-08-11T02:03:00.000Z",
          }),
        }),
      ).toThrow(/promotion digest/i);
    }

    const coherentlyRetimedProposal = structuredClone(promoted);
    coherentlyRetimedProposal.transitions.at(-1)!.at = "2026-08-11T01:59:00.000Z";
    expect(() =>
      rollbackProposal({
        proposal: coherentlyRetimedProposal,
        promotionRecord: { ...promotion, at: "2026-08-11T01:59:00.000Z" },
        decision: humanDecision({
          reason: "Attempt coherent timestamp substitution",
          decidedAt: "2026-08-11T02:03:00.000Z",
        }),
      }),
    ).toThrow(/promotion digest/i);

    const coherentlyRewrittenProposal = structuredClone(promoted);
    coherentlyRewrittenProposal.evaluation!.result.summary = "coherently rewritten summary";
    expect(() =>
      rollbackProposal({
        proposal: coherentlyRewrittenProposal,
        promotionRecord: {
          ...promotion,
          evaluation: {
            ...promotion.evaluation,
            summary: "coherently rewritten summary",
          },
        },
        decision: humanDecision({
          reason: "Attempt coherent evaluation substitution",
          decidedAt: "2026-08-11T02:03:00.000Z",
        }),
      }),
    ).toThrow(/promotion digest/i);

    expect(() =>
      parsePromotionRecord({
        ...promotion,
        previousActiveProposalId: "../bad",
      }),
    ).toThrow(EvolutionValidationError);
    expect(() =>
      parsePromotionRecord({
        ...promotion,
        previousActiveProposalId: promotion.proposalId,
      }),
    ).toThrow(/cannot restore itself/i);
  });

  it("binds evaluation.at to the evaluating -> evaluated transition timestamp", () => {
    const base = createProposed();
    const digest = computeCandidateDigest(base.candidate);
    const passingEvidence = {
      proposalId: base.id,
      candidateDigest: digest,
      items: [
        {
          kind: "deterministic",
          id: "unit-tests",
          status: "pass",
          summary: "ok",
        },
      ],
    };
    const passingResult = computeEvaluationResult(passingEvidence);

    // Evaluation timestamp differs from the evaluating -> evaluated transition.
    expect(() =>
      parseEvolutionProposal(
        {
          ...base,
          status: "evaluated",
          transitions: [
            { from: "proposed", to: "evaluating", at: "2026-08-11T01:01:00.000Z" },
            { from: "evaluating", to: "evaluated", at: "2026-08-11T01:02:00.000Z" },
          ],
          evaluation: {
            evidence: passingEvidence,
            result: passingResult,
            at: "2026-08-11T01:01:30.000Z",
          },
        },
        defaultTrust,
      ),
    ).toThrow(/evaluating -> evaluated|Evaluation timestamp/i);

    // Evaluation timestamp after a later promotion transition is impossible.
    expect(() =>
      parseEvolutionProposal(
        {
          ...base,
          status: "promoted",
          transitions: [
            { from: "proposed", to: "evaluating", at: "2026-08-11T01:01:00.000Z" },
            { from: "evaluating", to: "evaluated", at: "2026-08-11T01:02:00.000Z" },
            { from: "evaluated", to: "promoted", at: "2026-08-11T01:03:00.000Z" },
          ],
          evaluation: {
            evidence: passingEvidence,
            result: passingResult,
            at: "2026-08-11T01:04:00.000Z",
          },
        },
        defaultTrust,
      ),
    ).toThrow(/evaluating -> evaluated|Evaluation timestamp/i);

    // Matching timestamp is accepted.
    const ok = parseEvolutionProposal(
      {
        ...base,
        status: "evaluated",
        transitions: [
          { from: "proposed", to: "evaluating", at: "2026-08-11T01:01:00.000Z" },
          { from: "evaluating", to: "evaluated", at: "2026-08-11T01:02:00.000Z" },
        ],
        evaluation: {
          evidence: passingEvidence,
          result: passingResult,
          at: "2026-08-11T01:02:00.000Z",
        },
      },
      defaultTrust,
    );
    expect(ok.status).toBe("evaluated");
    expect(ok.evaluation?.at).toBe("2026-08-11T01:02:00.000Z");
  });
});
