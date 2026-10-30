// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceViewProps } from "../../web/src/app/WorkspaceView.js";
import type { PublicConfig, ProjectScope, RunState } from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  getEvolution: vi.fn().mockResolvedValue(undefined),
  getExperience: vi.fn().mockResolvedValue(undefined),
  getDesktopSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { WorkspaceView } = await import("../../web/src/app/WorkspaceView.js");

const scope: ProjectScope = { mode: "single", projectId: "p1" };

function config(): PublicConfig {
  return {
    project: { name: "demo", maxParallel: 2 },
    roles: {},
    strategies: { default: "demo", definitions: {} },
  } as unknown as PublicConfig;
}

function props(patch: Partial<WorkspaceViewProps> = {}): WorkspaceViewProps {
  const monitor = {
    config: config(),
    runs: [],
    run: undefined as RunState | undefined,
    events: [],
    connected: true,
    error: undefined,
    setError: vi.fn(),
    setSelectedRunId: vi.fn(),
    setSelectedTaskId: vi.fn(),
    resetRunScope: vi.fn(),
    refreshUsage: vi.fn().mockResolvedValue(undefined),
  };
  return {
    mode: "monitor",
    monitorView: "board",
    config: config(),
    scope,
    scopeKey: "single:p1",
    projectName: "demo",
    monitor: monitor as never,
    busy: false,
    monitorPanel: "overview",
    demo: false,
    actions: {
      exportRunEvents: vi.fn(),
      readEvidenceArtifact: vi.fn(),
      preflightBlueprint: vi.fn(),
      saveBlueprint: vi.fn(),
      deleteBlueprint: vi.fn(),
    } as never,
    onNavigate: vi.fn(),
    onSaved: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenGlobal: vi.fn(),
    onSelectRun: vi.fn(),
    onCreate: vi.fn(),
    onOpenCleanup: vi.fn(),
    onDeleteRun: vi.fn(),
    onLaunch: vi.fn(),
    onMonitorPanelChange: vi.fn(),
    onReviewApproval: vi.fn(),
    onSelectTask: vi.fn(),
    onError: vi.fn(),
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkspaceView routing", () => {
  it("renders the board for the monitor board view", () => {
    render(<WorkspaceView {...props()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lazily mounts each workbench behind the suspense fallback", () => {
    for (const mode of ["settings", "project", "evolution", "experience", "design"] as const) {
      const view = render(<WorkspaceView {...props({ mode })} />);
      expect(screen.getByRole("status")).toHaveTextContent("正在加载…");
      view.unmount();
    }
  });
});
