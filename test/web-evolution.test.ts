import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getEvolution } from "../web/src/api.js";
import {
  proposalStatusLabel,
  proposalProgress,
  toBlueprintDefinition,
  utf8ByteLength,
  utf8ToBase64,
  visibleEvolutionProposals,
} from "../web/src/evolution.js";
import type { EvolutionProposal, StrategyDefinition } from "../web/src/types.js";

describe("web evolution presentation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encodes Unicode prompt material as canonical UTF-8 base64", () => {
    const content = "\uFEFF你好，Agent 👋\n";
    const encoded = utf8ToBase64(content);

    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(content);
    expect(utf8ByteLength(content)).toBe(Buffer.byteLength(content, "utf8"));
    expect(encoded).toBe(Buffer.from(content, "utf8").toString("base64"));
  });

  it("keeps pending proposals first and applies status and text filters", () => {
    const proposed = proposal("proposal-new", "proposed", "2026-08-11T09:00:00.000Z");
    const evaluated = proposal("proposal-ready", "evaluated", "2026-08-11T08:00:00.000Z");
    const promoted = {
      ...proposal("proposal-live", "promoted", "2026-08-11T10:00:00.000Z"),
      application: application("proposal-live"),
    } satisfies EvolutionProposal;
    const legacy = proposal("proposal-legacy", "promoted", "2026-08-11T07:00:00.000Z");

    expect(visibleEvolutionProposals([promoted, evaluated, proposed, legacy], "open", "").map((item) => item.id))
      .toEqual(["proposal-new", "proposal-ready", "proposal-legacy"]);
    expect(visibleEvolutionProposals([proposed, promoted], "all", "live").map((item) => item.id))
      .toEqual(["proposal-live"]);
    expect(visibleEvolutionProposals([proposed, evaluated], "evaluated", "").map((item) => item.id))
      .toEqual(["proposal-ready"]);
    expect(proposalStatusLabel(legacy)).toBe("待登记");
    expect(proposalProgress(legacy)).toEqual({ step: 3, finalLabel: "待登记" });
    expect(proposalProgress(promoted)).toEqual({ step: 4, finalLabel: "已应用" });
  });

  it("removes server-only compiled and source fields from strategy candidates", () => {
    const definition: StrategyDefinition = {
      topology: { mode: "parallel-dag" },
      compiledTopology: {
        version: 1,
        mode: "parallel-dag",
        stages: [],
        edges: [],
      },
      source: "custom",
      maxParallel: 3,
      roleProfiles: { worker: "grok-worker" },
    };

    expect(toBlueprintDefinition(definition)).toEqual({
      topology: { mode: "parallel-dag" },
      maxParallel: 3,
      roleProfiles: { worker: "grok-worker" },
    });
  });

  it("preserves stable server error codes for recovery and stale-preview handling", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Preview is stale", code: "STALE_PREVIEW" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )));

    const error = await getEvolution({ mode: "single", projectId: "project" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "STALE_PREVIEW" });
  });
});

function proposal(
  id: string,
  status: EvolutionProposal["status"],
  createdAt: string,
): EvolutionProposal {
  return {
    id,
    createdAt,
    status,
    candidate: {
      kind: "strategy-blueprint",
      name: id,
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
  };
}

function application(proposalId: string): NonNullable<EvolutionProposal["application"]> {
  return {
    proposalId,
    target: { kind: "strategy-blueprint", name: proposalId },
    status: "applied",
    beforeTargetDigest: null,
    afterTargetDigest: "a".repeat(64),
    rollbackSafe: true,
    catalogRevision: 4,
    operator: "local-session:test",
    reason: "reviewed",
    appliedAt: "2026-08-11T10:00:00.000Z",
  };
}
