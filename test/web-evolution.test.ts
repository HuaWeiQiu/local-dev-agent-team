import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  archiveEvolutionProposal,
  deleteEvolutionProposal,
  getEvolution,
  startAutomaticEvolution,
  stopAutomaticEvolution,
  unarchiveEvolutionProposal,
} from "../web/src/api.js";
import {
  evolutionLocked,
  proposalStatusLabel,
  proposalProgress,
  toBlueprintDefinition,
  utf8ByteLength,
  utf8ToBase64,
  visibleEvolutionProposals,
} from "../web/src/evolution.js";
import type { EvolutionProposal, EvolutionSnapshot, StrategyDefinition } from "../web/src/types.js";

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

  it("keeps archived proposals out of default views and lists them only in the archived view", () => {
    const active = proposal("proposal-active", "evaluated", "2026-08-11T08:00:00.000Z");
    const archived: EvolutionProposal = {
      ...proposal("proposal-archived", "rejected", "2026-08-11T09:00:00.000Z"),
      archivedAt: "2026-08-12T09:00:00.000Z",
    };

    expect(visibleEvolutionProposals([active, archived], "all", "").map((item) => item.id))
      .toEqual(["proposal-active"]);
    expect(visibleEvolutionProposals([active, archived], "open", "").map((item) => item.id))
      .toEqual(["proposal-active"]);
    expect(visibleEvolutionProposals([active, archived], "rejected", "")).toEqual([]);
    expect(visibleEvolutionProposals([active, archived], "archived", "").map((item) => item.id))
      .toEqual(["proposal-archived"]);
    expect(visibleEvolutionProposals([active, archived], "archived", "不存在的名字")).toEqual([]);
  });

  it("requests archived proposals from the server only when the archived view asks", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { mode: "single", projectId: "project" } as const;

    await getEvolution(scope);
    await getEvolution(scope, { includeArchived: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/evolution", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/evolution?includeArchived=true", expect.anything());
  });

  it("uses the idempotent evolution action endpoints for archive, unarchive and delete", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { mode: "workspace", projectId: "project" } as const;

    await archiveEvolutionProposal(scope, "proposal-1", {}, "cmd-archive-1");
    await unarchiveEvolutionProposal(scope, "proposal-1", { reason: "恢复评审" }, "cmd-unarchive-1");
    await deleteEvolutionProposal(scope, "proposal-1", { reason: "无效候选" }, "cmd-delete-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project/evolution/proposals/proposal-1/actions/archive", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({}),
      headers: expect.objectContaining({ "Idempotency-Key": "cmd-archive-1" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project/evolution/proposals/proposal-1/actions/unarchive", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "恢复评审" }),
      headers: expect.objectContaining({ "Idempotency-Key": "cmd-unarchive-1" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project/evolution/proposals/proposal-1/actions/delete", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "无效候选" }),
      headers: expect.objectContaining({ "Idempotency-Key": "cmd-delete-1" }),
    }));
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

  it("uses the bounded automation endpoints and locks manual mutations while the loop owns the project", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "running" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "stopped" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = { mode: "single", projectId: "project" } as const;

    await expect(startAutomaticEvolution(scope, 3, "start-intent-1")).resolves.toMatchObject({ status: "running" });
    await expect(stopAutomaticEvolution(scope)).resolves.toMatchObject({ status: "stopped" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/evolution/automation/start", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ maxCycles: 3 }),
      headers: expect.objectContaining({ "Idempotency-Key": "start-intent-1" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/evolution/automation/stop", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({}),
    }));

    const snapshot = {
      recoveryRequired: false,
      pendingOperation: null,
      automation: { status: "idle" },
    } as EvolutionSnapshot;
    expect(evolutionLocked(snapshot)).toBe(false);
    snapshot.automation.status = "running";
    expect(evolutionLocked(snapshot)).toBe(true);
    snapshot.automation.status = "stopping";
    expect(evolutionLocked(snapshot)).toBe(true);
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
