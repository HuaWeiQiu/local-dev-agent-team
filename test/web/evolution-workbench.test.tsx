// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen, waitFor } from "@testing-library/react";
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

const { EvolutionWorkbench } = await import(
  "../../web/src/components/EvolutionWorkbench.js"
);

const scope = { id: "p1", name: "demo", root: "/repo" };
const config = { roles: [], strategies: { default: "demo", definitions: [] } } as never;

function proposal(id: string, status: EvolutionSnapshot["proposals"][number]["status"]) {
  return {
    id,
    createdAt: "2026-10-30T00:00:00.000Z",
    status,
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
    promptRoles: [{ role: "worker", path: "prompts/worker.md" }],
    proposals: [proposal("p-1", "evaluated")],
    activeProposals: [],
    auditRecords: [],
    completedApplications: [],
    pendingOperation: null,
    automation: automation(),
    evidenceScope: "server-structural-preflight-not-candidate-execution",
    ...patch,
  };
}

function viewport({ twoPane = false, wide = false }: { twoPane?: boolean; wide?: boolean }): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("1180") ? wide : twoPane,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getEvolution.mockResolvedValue(snapshot());
});

describe("EvolutionWorkbench", () => {
  it("loads the control plane and shows the candidate rail", async () => {
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(await screen.findByRole("region", { name: "演进工作台" })).toBeTruthy();
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(api.getEvolution).toHaveBeenCalledWith(scope, { includeArchived: false });
  });

  it("explains a locked control plane in the banner", async () => {
    api.getEvolution.mockResolvedValue(snapshot({ recoveryRequired: true }));
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(await screen.findByText("演进操作已锁定")).toBeVisible();
    expect(screen.getByText(/本地状态需要先恢复/)).toBeVisible();
  });

  it("shows the unrecoverable state instead of an empty shell", async () => {
    api.getEvolution.mockRejectedValue(new Error("boom"));
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(await screen.findByText("无法进入演进工作台")).toBeVisible();
    expect(screen.getByRole("button", { name: /重试/ })).toBeVisible();
  });

  it("surfaces an empty snapshot without crashing", async () => {
    api.getEvolution.mockResolvedValue(snapshot({ proposals: [] }));
    render(<EvolutionWorkbench scope={scope} config={config} />);
    await waitFor(() => expect(api.getEvolution).toHaveBeenCalled());
    expect(screen.getByRole("region", { name: "演进工作台" })).toBeTruthy();
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

describe("EvolutionWorkbench layout", () => {
  it("renders the wide layout with the action aside", async () => {
    viewport({ twoPane: true, wide: true });
    render(<EvolutionWorkbench scope={scope} config={config} />);
    await waitFor(() => expect(document.querySelector("aside")).not.toBeNull());
    expect(screen.getByRole("heading", { name: "下一步" })).toBeVisible();
  });

  it("asks for a selection when the wide layout has none", async () => {
    viewport({ twoPane: true, wide: true });
    window.innerWidth = 500;
    api.getEvolution.mockResolvedValue(snapshot({ proposals: [] }));
    render(<EvolutionWorkbench scope={scope} config={config} />);
    expect(await screen.findByText("选择一个候选")).toBeVisible();
    window.innerWidth = 1024;
  });

  it("keeps the rail only on a single-pane layout", async () => {
    viewport({ twoPane: false, wide: false });
    render(<EvolutionWorkbench scope={scope} config={config} />);
    await waitFor(() => expect(api.getEvolution).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "下一步" })).toBeNull();
  });
});
