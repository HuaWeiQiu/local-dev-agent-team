import { describe, expect, it } from "vitest";
import {
  evolutionStatusTone,
  proposalProgress,
  proposalStatusLabel,
  proposalStatusTone,
} from "../web/src/evolution.js";
import type {
  EvolutionEvaluation,
  EvolutionLifecycleStatus,
  EvolutionProposal,
} from "../web/src/types.js";

function evaluation(
  source: EvolutionEvaluation["source"],
  passed: boolean,
): EvolutionEvaluation {
  return {
    source,
    evidence: { proposalId: "p", candidateDigest: "d", items: [] },
    result: {
      proposalId: "p",
      candidateDigest: "d",
      passed,
      deterministicPassed: passed,
      advisoryPassed: passed,
      summary: passed ? "ok" : "failed",
      failedDeterministicIds: passed ? [] : ["check-1"],
      advisoryVerdicts: [],
    },
    at: "2026-08-11T09:00:00.000Z",
  };
}

function proposal(
  status: EvolutionLifecycleStatus,
  patch: Partial<EvolutionProposal> = {},
): EvolutionProposal {
  return {
    id: "p1",
    createdAt: "2026-08-11T08:00:00.000Z",
    status,
    candidate: {
      kind: "strategy-blueprint",
      name: "balanced",
      definition: { topology: { mode: "parallel-dag" }, roleProfiles: {} },
    },
    policy: {
      version: 1,
      capabilities: {
        automaticExecution: false,
        automaticPromotion: false,
        networkPublication: false,
        secretStorage: false,
      },
      allowedPromptPaths: [],
    },
    transitions: [],
    application: null,
    ...patch,
  };
}

const applied = {
  proposalId: "p1",
  target: { kind: "strategy-blueprint", name: "balanced" },
  status: "applied",
  beforeTargetDigest: null,
  afterTargetDigest: "a".repeat(64),
  rollbackSafe: true,
  catalogRevision: 4,
  operator: "local-session:test",
  reason: "reviewed",
  appliedAt: "2026-08-11T10:00:00.000Z",
} as const;

describe("evolutionStatusTone", () => {
  it.each([
    ["promoted", "success"],
    ["rejected", "danger"],
    ["evaluating", "active"],
    ["rolled-back", "neutral"],
    ["proposed", "warning"],
    ["evaluated", "warning"],
  ] as const)("paints %s as %s", (status, tone) => {
    expect(evolutionStatusTone(status)).toBe(tone);
  });
});

describe("proposalStatusLabel", () => {
  it("says an automatic evaluation is still deciding", () => {
    const item = proposal("evaluated", {
      evaluation: evaluation("server-automatic-run-evaluation-v1", false),
    });
    expect(proposalStatusLabel(item)).toBe("自动决策中");
  });

  it("asks for a fresh preflight when the evaluation came from outside", () => {
    const item = proposal("evaluated", { evaluation: evaluation("external", false) });
    expect(proposalStatusLabel(item)).toBe("需当前预检");
  });

  it("reports a failed preflight that we ran ourselves", () => {
    const item = proposal("evaluated", {
      evaluation: evaluation("server-structural-preflight-v1", false),
    });
    expect(proposalStatusLabel(item)).toBe("预检未通过");
  });

  it("drops back to the lifecycle label for a preflight that passed", () => {
    const item = proposal("evaluated", {
      evaluation: evaluation("server-structural-preflight-v1", true),
    });
    expect(proposalStatusLabel(item)).toBe("待决定");
  });

  it("marks a promoted proposal that never registered its application", () => {
    expect(proposalStatusLabel(proposal("promoted"))).toBe("待登记");
  });

  it("uses the lifecycle label once the application is registered", () => {
    expect(proposalStatusLabel(proposal("promoted", { application: applied }))).toBe("已应用");
    expect(proposalStatusLabel(proposal("rejected"))).toBe("已拒绝");
  });
});

describe("proposalStatusTone", () => {
  it("shows an automatic evaluation as active work", () => {
    const item = proposal("evaluated", {
      evaluation: evaluation("server-automatic-run-evaluation-v1", true),
    });
    expect(proposalStatusTone(item)).toBe("active");
  });

  it("shows a failed preflight as danger", () => {
    const item = proposal("evaluated", {
      evaluation: evaluation("server-structural-preflight-v1", false),
    });
    expect(proposalStatusTone(item)).toBe("danger");
  });

  it("warns about a promotion that still needs registering", () => {
    expect(proposalStatusTone(proposal("promoted"))).toBe("warning");
  });

  it("falls back to the lifecycle tone otherwise", () => {
    expect(proposalStatusTone(proposal("promoted", { application: applied }))).toBe("success");
    expect(proposalStatusTone(proposal("proposed"))).toBe("warning");
    expect(proposalStatusTone(proposal("rolled-back"))).toBe("neutral");
  });
});

describe("proposalProgress", () => {
  it("starts a proposed candidate on step one", () => {
    expect(proposalProgress(proposal("proposed"))).toEqual({ step: 1, finalLabel: "已应用" });
  });

  it.each(["evaluating", "evaluated"] as const)("keeps %s on the evaluation step", (status) => {
    expect(proposalProgress(proposal(status))).toEqual({ step: 2, finalLabel: "已应用" });
  });

  it("holds a promoted candidate at registration", () => {
    expect(proposalProgress(proposal("promoted"))).toEqual({ step: 3, finalLabel: "待登记" });
  });

  it.each([
    ["promoted", "已应用"],
    ["rejected", "已拒绝"],
    ["rolled-back", "已回滚"],
  ] as const)("ends %s on step four labelled %s", (status, finalLabel) => {
    expect(proposalProgress(proposal(status, { application: applied }))).toEqual({
      step: 4,
      finalLabel,
    });
  });
});
