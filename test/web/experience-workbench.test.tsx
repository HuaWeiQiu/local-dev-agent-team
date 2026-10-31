// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../web/src/ui/tooltip.js";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperienceSnapshot } from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  getExperience: vi.fn(),
  getEvolution: vi.fn(),
  promoteExperience: vi.fn(),
  rejectExperience: vi.fn(),
  retireExperience: vi.fn(),
  shareExperience: vi.fn(),
  retrieveExperience: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { ExperienceWorkbench } = await import("../../web/src/components/ExperienceWorkbench.js");
const {
  actionError,
  filterEntries,
  keepSelection,
  promoteOptions,
  statsOf,
} = await import("../../web/src/components/experience/workbench/model.js");

const scope = { mode: "single", projectId: "p1" } as never;

function entry(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    project: "demo",
    status: "candidate",
    summary: `summary ${id}`,
    conditions: ["条件"],
    sourceRunId: "run-1",
    sensitivity: "low",
    scope: "project",
    portability: "cross-project",
    tags: ["tag"],
    hitCount: 0,
    successCount: 0,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...patch,
  };
}

function snapshot(patch: Partial<ExperienceSnapshot> = {}): ExperienceSnapshot {
  return {
    project: "demo",
    projectPath: "/repo/.agent-team/experience/catalog.json",
    sharedPath: "/home/.agent-team/experience/shared/catalog.json",
    enabled: true,
    injectIntoPlanning: true,
    injectIntoRework: true,
    extractOnTerminal: true,
    requireSuiteForPromote: false,
    autoPromoteWithSuite: true,
    recordAttemptCards: true,
    writeStrategyHints: true,
    counts: { project: 2, shared: 1, verified: 1, candidate: 2 },
    entries: [entry("e-1"), entry("e-2", { status: "verified", scope: "shared" })],
    ...patch,
  } as ExperienceSnapshot;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getExperience.mockResolvedValue(snapshot());
  api.getEvolution.mockResolvedValue({ automation: { lastEvaluation: null } });
  api.retrieveExperience.mockResolvedValue(undefined);
  api.promoteExperience.mockResolvedValue(undefined);
});

describe("experience workbench model", () => {
  it("filters by status, scope and free text", () => {
    const snap = snapshot();
    expect(filterEntries(snap, "all", "")).toHaveLength(2);
    expect(filterEntries(snap, "shared", "")).toHaveLength(1);
    expect(filterEntries(snap, "project", "")).toHaveLength(1);
    expect(filterEntries(snap, "verified", "")).toHaveLength(1);
    expect(filterEntries(snap, "all", "summary e-2")).toHaveLength(1);
    expect(filterEntries(undefined, "all", "")).toEqual([]);
  });

  it("keeps a live selection and falls back to the first entry", () => {
    const entries = [entry("a"), entry("b")];
    expect(keepSelection(entries, "b")).toBe("b");
    expect(keepSelection(entries, "gone")).toBe("a");
    expect(keepSelection([], "a")).toBeUndefined();
  });

  it("validates the action dialog", () => {
    const base = { mode: "reject" as const, reason: "why", suiteDigest: "", forceWithoutSuite: false, requireSuite: false };
    expect(actionError(base)).toBeUndefined();
    expect(actionError({ ...base, reason: "  " })).toMatch(/请填写原因/);

    const promote = { ...base, mode: "promote" as const, requireSuite: true };
    expect(actionError(promote)).toMatch(/suiteDigest/);
    expect(actionError({ ...promote, forceWithoutSuite: true })).toBeUndefined();
    expect(actionError({ ...promote, suiteDigest: "short" })).toMatch(/64 位/);
    expect(actionError({ ...promote, suiteDigest: "a".repeat(64) })).toBeUndefined();
  });

  it("omits empty promote options and reports the counts", () => {
    expect(promoteOptions({ suiteDigest: "  ", forceWithoutSuite: false })).toEqual({});
    expect(promoteOptions({ suiteDigest: " " + "a".repeat(64), forceWithoutSuite: true })).toEqual({
      suiteDigest: "a".repeat(64),
      forceWithoutSuite: true,
    });
    expect(statsOf(snapshot()).map((stat) => stat.label)).toEqual(["候选", "已验证", "公共"]);
  });
});

describe("ExperienceWorkbench", () => {
  it("renders the list, the detail and the metrics", async () => {
    render(
      <TooltipProvider>
        <ExperienceWorkbench scope={scope} />
      </TooltipProvider>,
    );
    expect(await screen.findByRole("region", { name: "经验工作台" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "经验统计" })).toBeTruthy();
    await waitFor(() => expect(api.getExperience).toHaveBeenCalledWith(scope));
  });

  it("shows the retry state when the catalog fails to load", async () => {
    api.getExperience.mockRejectedValue(new Error("catalog down"));
    render(
      <TooltipProvider>
        <ExperienceWorkbench scope={scope} />
      </TooltipProvider>,
    );
    expect(await screen.findByText("加载失败")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(api.getExperience).toHaveBeenCalledTimes(2);
  });

  it("opens the promotion dialog and submits it", async () => {
    render(
      <TooltipProvider>
        <ExperienceWorkbench scope={scope} />
      </TooltipProvider>,
    );
    await screen.findByRole("region", { name: "经验工作台" });

    await userEvent.click(await screen.findByRole("button", { name: /晋升/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(api.getEvolution).toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: "确认" });
    await userEvent.click(confirm);
    await waitFor(() => expect(api.promoteExperience).toHaveBeenCalled());
  });

});
