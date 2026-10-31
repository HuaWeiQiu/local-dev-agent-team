import { describe, expect, it, vi } from "vitest";
import type { CliId } from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  getEvolution: vi.fn(),
  rejectEvolutionProposal: vi.fn(),
  reconcileEvolutionProposal: vi.fn(),
  deleteEvolutionProposal: vi.fn(),
  confirmEvolutionPromotion: vi.fn(),
  confirmEvolutionRollback: vi.fn(),
  proposeEvolutionStrategy: vi.fn(),
  proposeEvolutionPrompt: vi.fn(),
  previewEvolutionPromotion: vi.fn(),
  previewEvolutionRollback: vi.fn(),
  evaluateEvolutionProposal: vi.fn(),
  startAutomaticEvolution: vi.fn(),
  stopAutomaticEvolution: vi.fn(),
  archiveEvolutionProposal: vi.fn(),
  unarchiveEvolutionProposal: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { describeDecision, runDecision, submitProposal } = await import(
  "../../web/src/components/evolution/workbench/actions.js"
);
const model = await import("../../web/src/components/evolution/workbench/model.js");
type Snapshot = import("../../web/src/types.js").EvolutionSnapshot;
type Proposal = import("../../web/src/types.js").EvolutionProposal;
type Decision = import("../../web/src/components/EvolutionDecisionDialog.js").EvolutionDecision;

const scope = { id: "p1", name: "demo", root: "/repo" };

function proposal(id: string, archived = false): Proposal {
  return {
    id,
    createdAt: "2026-10-30T00:00:00.000Z",
    ...(archived ? { archivedAt: "2026-10-30T01:00:00.000Z" } : {}),
    status: "evaluated",
    candidate: {
      kind: "role-prompt",
      path: "prompts/worker.md",
      contentDigest: "a".repeat(64),
    },
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
    transitions: [{ from: "proposed", to: "evaluated", at: "2026-10-30T00:30:00.000Z" }],
    application: null,
  };
}

function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    catalogRevision: 7,
    applicationRevision: 3,
    recoveryRequired: false,
    promptRoles: [{ role: "worker", path: "prompts/worker.md" }],
    proposals: [proposal("p-1")],
    activeProposals: [],
    auditRecords: [],
    completedApplications: [],
    pendingOperation: null,
    automation: automation(),
    evidenceScope: "server-structural-preflight-not-candidate-execution",
    ...patch,
  };
}

function preview(mode: "promote" | "rollback", expiresAt = "2099-01-01T00:00:00.000Z") {
  return {
    preview: {
      token: "token-1",
      catalogRevision: 9,
      expiresAt,
    },
  } as unknown as NonNullable<Decision["preview"]>;
}

describe("evolution workbench model", () => {
  it("keeps a live selection and falls back to the first proposal when wide", () => {
    const list = [proposal("a"), proposal("b")];
    expect(model.nextSelection(list, "b", true)).toBe("b");
    expect(model.nextSelection(list, "gone", true)).toBe("a");
    expect(model.nextSelection(list, "gone", false)).toBeUndefined();
    expect(model.nextSelection([], "x", true)).toBeUndefined();
  });

  it("derives the selected proposal, audit trail and completed applications", () => {
    const snap = snapshot({
      auditRecords: [
        { kind: "promotion", proposalId: "p-1", actor: "op", reason: "ok", at: "2026-10-30T02:00:00.000Z" },
        { kind: "rejection", proposalId: "other", actor: "op", reason: "no", at: "2026-10-30T02:00:00.000Z" },
      ] as Snapshot["auditRecords"],
      completedApplications: [
        { proposalId: "p-1", appliedAt: "2026-10-30T03:00:00.000Z" },
      ] as unknown as Snapshot["completedApplications"],
    });
    expect(model.selectedProposal(snap, "p-1")?.id).toBe("p-1");
    expect(model.selectedProposal(snap, "nope")).toBeUndefined();
    expect(model.auditFor(snap, "p-1")).toHaveLength(1);
    expect(model.auditFor(snap, undefined)).toEqual([]);
    expect(model.completedFor(snap, "p-1")).toHaveLength(1);
    expect(model.completedFor(snap, undefined)).toEqual([]);
  });

  it("locks mutations on recovery or a pending operation and explains why", () => {
    expect(model.mutationLocked(snapshot())).toBe(false);
    const recovering = snapshot({ recoveryRequired: true });
    expect(model.mutationLocked(recovering)).toBe(true);
    expect(model.lockReason(recovering)).toMatch(/先恢复/);
    expect(
      model.lockReason(
        snapshot({
          pendingOperation: {
            operation: "promote-and-apply",
            proposalId: "p-1",
            startedAt: "2026-10-30T00:00:00.000Z",
          },
        }),
      ),
    ).toMatch(/正在处理/);
  });

  it("filters proposals and clamps automation cycles", () => {
    expect(model.proposalsFor(snapshot(), "all", "")).toHaveLength(1);
    expect(model.proposalsFor(undefined, "all", "")).toEqual([]);
    expect(model.automationActive("running")).toBe(true);
    expect(model.automationActive("stopping")).toBe(true);
    expect(model.automationActive("idle")).toBe(false);
    expect(model.clampCycles(10)).toBe(3);
    expect(model.clampCycles(2)).toBe(2);
  });
});

describe("evolution workbench actions", () => {
  it("describes every decision mode", () => {
    const snap = snapshot();
    const base = { proposalId: "p-1", commandId: "cmd-1" };

    expect(describeDecision({ ...base, mode: "reject" } as Decision, snap, "not ready")).toEqual({
      mode: "reject",
      proposalId: "p-1",
      reason: "not ready",
    });

    expect(describeDecision({ ...base, mode: "adopt" } as Decision, snap, "adopt it")).toEqual({
      mode: "adopt",
      proposalId: "p-1",
      reason: "adopt it",
      expectedRevision: 7,
    });

    expect(describeDecision({ ...base, mode: "delete" } as Decision, snap, "cleanup")).toEqual({
      mode: "delete",
      proposalId: "p-1",
      reason: "cleanup",
    });

    const promote = describeDecision(
      { ...base, mode: "promote", preview: preview("promote") } as Decision,
      snap,
      "ship it",
    );
    expect(promote).toMatchObject({ mode: "promote", expectedRevision: 9, token: "token-1" });

    const rollback = describeDecision(
      { ...base, mode: "rollback", preview: preview("rollback") } as Decision,
      snap,
      "undo",
    );
    expect(rollback.mode).toBe("rollback");

    // A submitted reason wins over the freshly typed one.
    expect(
      describeDecision(
        { ...base, mode: "reject", submittedReason: "first" } as Decision,
        snap,
        "second",
      ).reason,
    ).toBe("first");
  });

  it("refuses an expired or missing preview", () => {
    const snap = snapshot();
    expect(() =>
      describeDecision({ proposalId: "p", commandId: "c", mode: "promote" } as Decision, snap, "x"),
    ).toThrow(/预览已经过期/);
    expect(() =>
      describeDecision(
        {
          proposalId: "p",
          commandId: "c",
          mode: "promote",
          preview: preview("promote", "2000-01-01T00:00:00.000Z"),
        } as Decision,
        snap,
        "x",
      ),
    ).toThrow(/预览已经过期/);
  });

  it("dispatches each decision mode to its command with the right arguments", async () => {
    api.rejectEvolutionProposal.mockResolvedValue({});
    api.reconcileEvolutionProposal.mockResolvedValue({});
    api.deleteEvolutionProposal.mockResolvedValue({});
    api.confirmEvolutionPromotion.mockResolvedValue({});
    api.confirmEvolutionRollback.mockResolvedValue({});

    await runDecision(scope, { mode: "reject", proposalId: "p-1", reason: "no" }, "c1");
    expect(api.rejectEvolutionProposal).toHaveBeenCalledWith(scope, "p-1", "no");

    await runDecision(
      scope,
      { mode: "adopt", proposalId: "p-1", reason: "yes", expectedRevision: 4 },
      "c2",
    );
    expect(api.reconcileEvolutionProposal).toHaveBeenCalledWith(
      scope,
      "p-1",
      { expectedRevision: 4, reason: "yes" },
      "c2",
    );

    await runDecision(scope, { mode: "delete", proposalId: "p-1", reason: "bye" }, "c3");
    expect(api.deleteEvolutionProposal).toHaveBeenCalledWith(scope, "p-1", { reason: "bye" }, "c3");

    const confirm = { expectedRevision: 9, token: "t", reason: "ship" };
    await runDecision(scope, { mode: "promote", proposalId: "p-1", ...confirm }, "c4");
    expect(api.confirmEvolutionPromotion).toHaveBeenCalledWith(scope, "p-1", confirm, "c4");

    await runDecision(scope, { mode: "rollback", proposalId: "p-1", ...confirm }, "c5");
    expect(api.confirmEvolutionRollback).toHaveBeenCalledWith(scope, "p-1", confirm, "c5");
  });

  it("creates a candidate from either dialog payload", async () => {
    api.proposeEvolutionStrategy.mockResolvedValue({ proposal: { id: "new-strategy" } });
    api.proposeEvolutionPrompt.mockResolvedValue({ proposal: { id: "new-prompt" } });

    expect(
      await submitProposal(scope, {
        kind: "strategy",
        name: "tighten",
        definition: {} as never,
        commandId: "c1",
      }),
    ).toBe("new-strategy");
    expect(api.proposeEvolutionStrategy).toHaveBeenCalledWith(
      scope,
      { name: "tighten", definition: {} },
      "c1",
    );

    expect(
      await submitProposal(scope, {
        kind: "prompt",
        role: "worker",
        content: "hello",
        commandId: "c2",
      }),
    ).toBe("new-prompt");
    const [, promptArgs] = api.proposeEvolutionPrompt.mock.calls[0]!;
    expect(promptArgs.role).toBe("worker");
    expect(promptArgs.encoding).toBe("base64");
    expect(promptArgs.content).not.toBe("hello");
  });

  it("types CLI labels used by the workbench", () => {
    // Keeps the CliId import honest without touching the API surface.
    const id: CliId = "kimi";
    expect(id).toBe("kimi");
  });
});

function automation(
  patch: Partial<import("../../web/src/types.js").AutomaticEvolutionSnapshot> = {},
): import("../../web/src/types.js").AutomaticEvolutionSnapshot {
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
    ...patch,
  };
}
