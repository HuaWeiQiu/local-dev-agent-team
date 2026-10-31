// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runState } from "../support/web-fixtures.js";
import type { RunState } from "../../web/src/types.js";

const hooks = vi.hoisted(() => ({
  useLiveAgents: vi.fn(),
  useRunInsights: vi.fn(),
}));

vi.mock("../../web/src/hooks/useLiveAgents", () => ({ useLiveAgents: hooks.useLiveAgents }));
vi.mock("../../web/src/hooks/useRunInsights", () => ({ useRunInsights: hooks.useRunInsights }));

const { RunPage } = await import("../../web/src/components/RunPage.js");
const { needsAlerts } = await import("../../web/src/components/run-page/sections.js");
const { useRunPageHandlers } = await import("../../web/src/components/run-page/hooks.js");

function monitor(run: RunState | undefined) {
  return {
    selectedRunId: "run-fixture",
    run,
    selectedTaskId: undefined,
    events: [],
    connected: true,
    evidence: undefined,
    evidenceLoading: false,
    usageReport: undefined,
    usageLoading: false,
  } as never;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    scope: { mode: "single", projectId: "p1" },
    monitor: monitor(runState()),
    busy: false,
    monitorPanel: "overview",
    onMonitorPanelChange: vi.fn(),
    onReviewApproval: vi.fn(),
    onSelectTask: vi.fn(),
    onExportEvents: vi.fn().mockResolvedValue(undefined),
    onReadArtifact: vi.fn().mockResolvedValue({ content: "" }),
    onRefreshUsage: vi.fn(),
    ...patch,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useLiveAgents.mockReturnValue({ agents: [], steer: vi.fn(), interrupt: vi.fn(), answer: vi.fn() });
  hooks.useRunInsights.mockReturnValue({ explanation: undefined, loadDiff: vi.fn(), insights: undefined });
});

describe("RunPage", () => {
  it("asks for a run when none is selected", () => {
    render(<RunPage {...props({ monitor: monitor(undefined) })} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载运行…");
  });

  it("shows the goal, stage stepper and tabs", () => {
    render(<RunPage {...props()} />);
    const headings = screen.getAllByRole("heading").map((node) => node.textContent ?? "");
    expect(headings.some((text) => text.includes("实现登录页"))).toBe(true);
    expect(screen.getByRole("tablist", { name: "运行视图" })).toBeTruthy();
  });

  it("reports a tab change", async () => {
    const onMonitorPanelChange = vi.fn();
    render(<RunPage {...props({ onMonitorPanelChange })} />);
    await userEvent.click(screen.getByRole("tab", { name: /架构/ }));
    expect(onMonitorPanelChange).toHaveBeenCalledWith("graph");
  });

  it("shows the live bar and the pending approval in the alert stack", () => {
    const approval = {
      id: "a-1",
      gate: "final",
      status: "pending",
      summary: "release?",
      checkpointId: "c-1",
      requestedAt: "2026-08-11T18:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const run = runState({
      status: "implementing",
      approvals: [approval],
      tasks: [
        {
          task: {
            id: "T1",
            title: "Task T1",
            description: "d",
            dependsOn: [],
            ownedPaths: ["src/a.ts"],
            acceptanceCommands: [],
            profile: null,
          },
          status: "running",
          attempts: 1,
        },
      ],
    });
    render(
      <RunPage
        {...props({
          monitor: { ...(monitor(run) as object), selectedTaskId: "T1" },
          busy: false,
        })}
      />,
    );
    expect(screen.getByLabelText("待处理审批")).toBeVisible();
    expect(screen.getByText(/等待你审批/)).toBeVisible();
  });

  it("renders the inspector beside the grid on a wide layout", () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("1100"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    render(<RunPage {...props()} />);
    expect(screen.getByRole("complementary")).toBeTruthy();
  });

  it("mounts the graph canvas only while the graph tab is active", () => {
    const { rerender } = render(<RunPage {...props({ monitorPanel: "graph" })} />);
    expect(screen.getByRole("tab", { name: /架构/ })).toHaveAttribute("data-state", "active");
    rerender(<RunPage {...props({ monitorPanel: "overview" })} />);
    expect(screen.getByRole("tab", { name: /概览/ })).toHaveAttribute("data-state", "active");
  });
});

describe("run page handlers", () => {
  function harness(wide: boolean) {
    const calls = {
      stage: vi.fn(),
      module: vi.fn(),
      task: vi.fn(),
      panel: vi.fn(),
    };
    const handlers = useRunPageHandlers({
      wide,
      setSelectedStageId: calls.stage,
      setSelectedModuleId: calls.module,
      onSelectTask: calls.task,
      onMonitorPanelChange: calls.panel,
    });
    return { handlers, calls };
  }

  it("routes stepper clicks to the graph panel", () => {
    const { handlers, calls } = harness(true);
    handlers.selectStageFromStepper("plan" as never);
    expect(calls.stage).toHaveBeenCalledWith("plan");
    expect(calls.module).toHaveBeenCalledWith(undefined);
    expect(calls.task).toHaveBeenCalledWith(undefined);
    expect(calls.panel).toHaveBeenCalledWith("graph");
  });

  it("opens the details pane only on a narrow layout", () => {
    const narrow = harness(false);
    narrow.handlers.openModuleInDag("m1");
    expect(narrow.calls.panel).toHaveBeenCalledWith("details");

    const wide = harness(true);
    wide.handlers.openModuleInDag("m1");
    expect(wide.calls.panel).not.toHaveBeenCalled();

    wide.handlers.openStageInDag("plan" as never);
    expect(wide.calls.panel).not.toHaveBeenCalled();
    narrow.handlers.openStageInDag("plan" as never);
    expect(narrow.calls.panel).toHaveBeenCalledWith("details");
  });

  it("clears the module and opens activity", () => {
    const { handlers, calls } = harness(true);
    handlers.clearModule();
    expect(calls.module).toHaveBeenCalledWith(undefined);
    handlers.openActivity();
    expect(calls.panel).toHaveBeenCalledWith("activity");
    handlers.openArchitecture();
    expect(calls.panel).toHaveBeenCalledWith("graph");
    expect(calls.task).toHaveBeenCalledWith(undefined);
  });

  it("decides whether the alert stack is worth rendering", () => {
    const base = { liveStatus: undefined, questionCount: 0 } as never;
    const approval = { id: "a" } as never;
    expect(needsAlerts(base, approval)).toBe(true);
    expect(needsAlerts({ liveStatus: { running: true }, questionCount: 0 } as never, undefined)).toBe(true);
    expect(
      needsAlerts({ liveStatus: { pendingApprovals: 1 }, questionCount: 0 } as never, undefined),
    ).toBe(true);
    expect(needsAlerts({ liveStatus: undefined, questionCount: 2 } as never, undefined)).toBe(true);
    expect(needsAlerts({ liveStatus: { running: false }, questionCount: 0 } as never, undefined)).toBe(
      false,
    );
  });
});
