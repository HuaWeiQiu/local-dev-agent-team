// @vitest-environment jsdom
import "./dom-setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvolutionSnapshot } from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  getEvolution: vi.fn(),
  evaluateEvolutionProposal: vi.fn(),
  previewEvolutionPromotion: vi.fn(),
  previewEvolutionRollback: vi.fn(),
  rejectEvolutionProposal: vi.fn(),
  archiveEvolutionProposal: vi.fn(),
  unarchiveEvolutionProposal: vi.fn(),
  deleteEvolutionProposal: vi.fn(),
  reconcileEvolutionProposal: vi.fn(),
  confirmEvolutionPromotion: vi.fn(),
  confirmEvolutionRollback: vi.fn(),
  proposeEvolutionStrategy: vi.fn(),
  proposeEvolutionPrompt: vi.fn(),
  startAutomaticEvolution: vi.fn(),
  stopAutomaticEvolution: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { useEvolutionWorkbench } = await import(
  "../../web/src/components/evolution/workbench/useEvolutionWorkbench.js"
);
const { ApiError } = await import("../../web/src/api.js");

const scope = { id: "p1", name: "demo", root: "/repo" };

function automation(): EvolutionSnapshot["automation"] {
  return {
    enabled: true,
    autoStart: false,
    status: "idle",
    phase: "idle",
    configuredMaxCycles: 3,
    requestedMaxCycles: null,
    completedCycles: 0,
    maxConsecutiveNoImprovement: 2,
    consecutiveNoImprovement: 0,
    evaluationRepeats: 1,
    minimumScoreDelta: 150,
    baselineStrategy: null,
    targetStrategy: "demo",
    sessionId: null,
    activeRunId: null,
    incumbentScore: null,
    incumbentStrategy: null,
    stopReason: null,
    error: null,
    failureCode: null,
    roleBindingSource: null,
    startedAt: null,
    updatedAt: "2026-10-30T00:00:00.000Z",
    lastEvaluation: null,
    cycles: [],
  };
}

function proposal(id: string): EvolutionSnapshot["proposals"][number] {
  return {
    id,
    createdAt: "2026-10-30T00:00:00.000Z",
    status: "evaluated",
    candidate: { kind: "role-prompt", path: "prompts/worker.md", contentDigest: "a".repeat(64) },
    policy: {
      version: 1,
      capabilities: {
        automaticExecution: false,
        automaticPromotion: false,
        networkPublication: false,
        secretStorage: false,
      },
      allowedPromptPaths: ["prompts/worker.md"],
    },
    transitions: [],
    application: null,
  } as EvolutionSnapshot["proposals"][number];
}

function snapshot(patch: Partial<EvolutionSnapshot> = {}): EvolutionSnapshot {
  return {
    catalogRevision: 7,
    applicationRevision: 3,
    recoveryRequired: false,
    promptRoles: [],
    proposals: [proposal("p-1"), proposal("p-2")],
    activeProposals: [],
    auditRecords: [],
    completedApplications: [],
    pendingOperation: null,
    automation: automation(),
    evidenceScope: "server-structural-preflight-not-candidate-execution",
    ...patch,
  };
}

function preview(): NonNullable<import("../../web/src/components/EvolutionDecisionDialog.js").EvolutionDecision["preview"]> {
  return {
    preview: { token: "tok", catalogRevision: 9, expiresAt: "2099-01-01T00:00:00.000Z" },
  } as never;
}

async function ready() {
  const view = renderHook(() => useEvolutionWorkbench({ scope }));
  await waitFor(() => expect(view.result.current.snapshot).toBeDefined());
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getEvolution.mockResolvedValue(snapshot());
  api.evaluateEvolutionProposal.mockResolvedValue({});
  api.previewEvolutionPromotion.mockResolvedValue(preview());
  api.rejectEvolutionProposal.mockResolvedValue({});
  api.archiveEvolutionProposal.mockResolvedValue({});
  api.unarchiveEvolutionProposal.mockResolvedValue({});
  api.deleteEvolutionProposal.mockResolvedValue({});
  api.reconcileEvolutionProposal.mockResolvedValue({});
  api.confirmEvolutionPromotion.mockResolvedValue({});
  api.startAutomaticEvolution.mockResolvedValue({});
  api.stopAutomaticEvolution.mockResolvedValue({});
});

describe("useEvolutionWorkbench", () => {
  it("loads the snapshot and selects the first proposal", async () => {
    const view = await ready();
    expect(view.result.current.selected?.id).toBe("p-1");
    expect(view.result.current.locked).toBe(false);
    expect(view.result.current.mutationLocked).toBe(false);
  });

  it("evaluates the selected proposal and refreshes", async () => {
    const view = await ready();
    await act(async () => {
      await view.result.current.evaluate();
    });
    expect(api.evaluateEvolutionProposal).toHaveBeenCalledWith(scope, "p-1");
    expect(api.getEvolution.mock.calls.length).toBeGreaterThan(1);
  });

  it("reports a failed mutation in the panel", async () => {
    api.evaluateEvolutionProposal.mockRejectedValue(new Error("nope"));
    const view = await ready();
    await act(async () => {
      await view.result.current.evaluate();
    });
    expect(view.result.current.error).toMatch(/nope|失败/);
  });

  it("resyncs when the server says the state moved", async () => {
    api.evaluateEvolutionProposal.mockRejectedValue(
      new ApiError(409, "revision changed", "STALE_CATALOG_REVISION"),
    );
    const view = await ready();
    await act(async () => {
      await view.result.current.evaluate();
    });
    await waitFor(() => expect(view.result.current.error).toMatch(/重新查看预览|已经变化/));
  });

  it("opens a promotion preview and keeps it as a pending decision", async () => {
    const view = await ready();
    await act(async () => {
      await view.result.current.openPreview("promote");
    });
    expect(api.previewEvolutionPromotion).toHaveBeenCalledWith(scope, "p-1", 7);
    expect(view.result.current.decision?.mode).toBe("promote");
  });

  it("explains a 409 preview by refreshing the rail", async () => {
    api.previewEvolutionPromotion.mockRejectedValue(new ApiError(409, "moved"));
    const view = await ready();
    await act(async () => {
      await view.result.current.openPreview("promote");
    });
    expect(view.result.current.error).toMatch(/请核对最新状态后重新预览/);
    expect(view.result.current.decision).toBeUndefined();
  });

  it("submits a rejection decision with the typed reason", async () => {
    const view = await ready();
    act(() => {
      view.result.current.openReasonDecision("reject");
    });
    await act(async () => {
      await view.result.current.submitDecision("too risky");
    });
    expect(api.rejectEvolutionProposal).toHaveBeenCalledWith(scope, "p-1", "too risky");
    expect(view.result.current.decision).toBeUndefined();
  });

  it("submits a delete decision and an adopt decision", async () => {
    const view = await ready();
    act(() => {
      view.result.current.openDeleteDecision();
    });
    await act(async () => {
      await view.result.current.submitDecision("cleanup");
    });
    expect(api.deleteEvolutionProposal).toHaveBeenCalledWith(
      scope,
      "p-1",
      { reason: "cleanup" },
      expect.any(String),
    );

    act(() => {
      view.result.current.openReasonDecision("adopt");
    });
    await act(async () => {
      await view.result.current.submitDecision("take it");
    });
    expect(api.reconcileEvolutionProposal).toHaveBeenCalledWith(
      scope,
      "p-1",
      { expectedRevision: 7, reason: "take it" },
      expect.any(String),
    );
  });

  it("confirms a promotion through its preview token", async () => {
    const view = await ready();
    await act(async () => {
      await view.result.current.openPreview("promote");
    });
    await act(async () => {
      await view.result.current.submitDecision("ship");
    });
    expect(api.confirmEvolutionPromotion).toHaveBeenCalledWith(
      scope,
      "p-1",
      { expectedRevision: 9, token: "tok", reason: "ship" },
      expect.any(String),
    );
  });

  it("archives and unarchives the selection", async () => {
    const view = await ready();
    await act(async () => {
      await view.result.current.archive();
    });
    expect(api.archiveEvolutionProposal).toHaveBeenCalledWith(
      scope,
      "p-1",
      {},
      expect.any(String),
    );
    await act(async () => {
      await view.result.current.unarchive();
    });
    expect(api.unarchiveEvolutionProposal).toHaveBeenCalled();
  });

  it("starts and stops automatic evolution", async () => {
    const view = await ready();
    await act(async () => {
      await view.result.current.startAutomation();
    });
    expect(api.startAutomaticEvolution).toHaveBeenCalledWith(scope, 3, expect.any(String));

    await act(async () => {
      await view.result.current.stopAutomation();
    });
    expect(api.stopAutomaticEvolution).toHaveBeenCalledWith(scope);
  });

  it("reports a start that never left idle, and one it cannot confirm", async () => {
    api.startAutomaticEvolution.mockRejectedValue(new Error("cannot start"));
    const view = await ready();
    await act(async () => {
      await view.result.current.startAutomation();
    });
    await waitFor(() => expect(view.result.current.error).toBeTruthy());

    api.getEvolution.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await view.result.current.startAutomation();
    });
    await waitFor(() =>
      expect(view.result.current.error).toMatch(/启动结果暂时无法确认|失败/),
    );
  });

  it("keeps the selection valid when the filter hides it", async () => {
    const view = await ready();
    act(() => {
      view.result.current.setFilter("archived");
    });
    await waitFor(() => expect(api.getEvolution).toHaveBeenLastCalledWith(scope, { includeArchived: true }));
  });

  it("closes the dialogs only when no mutation is running", async () => {
    api.evaluateEvolutionProposal.mockImplementation(() => new Promise(() => undefined));
    const view = await ready();

    act(() => {
      view.result.current.setCreating(true);
      view.result.current.closeCreating();
    });
    expect(view.result.current.creating).toBe(false);

    act(() => {
      view.result.current.openReasonDecision("reject");
    });
    expect(view.result.current.decision).toBeDefined();
    act(() => {
      view.result.current.closeDecision();
    });
    expect(view.result.current.decision).toBeUndefined();

    // A running mutation keeps the dialog open so the error stays visible.
    void act(() => {
      view.result.current.openReasonDecision("reject");
    });
    await act(async () => {
      void view.result.current.evaluate();
    });
    await waitFor(() => expect(view.result.current.busy).toBe(true));
    act(() => {
      view.result.current.closeDecision();
    });
    expect(view.result.current.decision).toBeDefined();
  });
});
