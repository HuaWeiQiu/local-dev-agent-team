// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicConfig, RunState, RunSummary, WorkspaceInfo } from "../../web/src/types.js";

const hooks = vi.hoisted(() => ({
  useRunEvents: vi.fn(),
  useRunActions: vi.fn(),
  useDesktopSettings: vi.fn(),
  useDesktopProject: vi.fn(),
  useOnboarding: vi.fn(),
  useThemeMode: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock("../../web/src/hooks/useRunEvents", () => ({
  useRunEvents: hooks.useRunEvents,
  latestPendingApproval: () => undefined,
}));
vi.mock("../../web/src/hooks/useRunActions", () => ({ useRunActions: hooks.useRunActions }));
vi.mock("../../web/src/hooks/useDesktopSettings", () => ({
  useDesktopSettings: hooks.useDesktopSettings,
}));
vi.mock("../../web/src/hooks/useDesktopProject", () => ({
  useDesktopProject: hooks.useDesktopProject,
}));
vi.mock("../../web/src/hooks/useOnboarding", () => ({ useOnboarding: hooks.useOnboarding }));
vi.mock("../../web/src/hooks/useThemeMode", () => ({ useThemeMode: hooks.useThemeMode }));
vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, getWorkspace: hooks.getWorkspace };
});

const App = (await import("../../web/src/App.js")).default;

function workspace(): WorkspaceInfo {
  return {
    mode: "single",
    projects: [
      { id: "p1", name: "demo", root: "/repo", hasConfig: true },
      { id: "p2", name: "other", root: "/other", hasConfig: true },
    ],
    defaultProjectId: "p1",
  } as unknown as WorkspaceInfo;
}

function summary(id: string): RunSummary {
  return {
    id,
    goal: "tighten the quality gate",
    status: "completed",
    taskCounts: { passed: 1 },
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  } as unknown as RunSummary;
}

function config(): PublicConfig {
  return {
    project: { name: "demo", maxParallel: 2 },
    roles: { worker: { defaultProfile: "p1", allowedProfiles: ["p1"] } },
    strategies: { default: "demo", definitions: { demo: {} } },
  } as unknown as PublicConfig;
}

function monitor(patch: Record<string, unknown> = {}) {
  return {
    config: config(),
    runs: [summary("r-1")],
    run: undefined as RunState | undefined,
    connected: true,
    error: undefined as string | undefined,
    setError: vi.fn(),
    setSelectedRunId: vi.fn(),
    setSelectedTaskId: vi.fn(),
    resetRunScope: vi.fn(),
    refreshUsage: vi.fn().mockResolvedValue(undefined),
    ...patch,
  };
}

function actions() {
  return {
    busy: false,
    runAction: undefined,
    cleanupOpen: false,
    cleanupPreview: undefined,
    cleanupError: undefined,
    setBusy: vi.fn(),
    setRunAction: vi.fn(),
    setCleanupOpen: vi.fn(),
    setCleanupPreview: vi.fn(),
    setCleanupError: vi.fn(),
    openCleanup: vi.fn(),
    handleDeleteRun: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(true),
    publish: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    submitRunAction: vi.fn(),
    preflightBlueprint: vi.fn(),
    saveBlueprint: vi.fn(),
    deleteBlueprint: vi.fn(),
    exportRunEvents: vi.fn(),
    readEvidenceArtifact: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.getWorkspace.mockResolvedValue(workspace());
  hooks.useRunEvents.mockReturnValue(monitor());
  hooks.useRunActions.mockReturnValue(actions());
  hooks.useDesktopSettings.mockReturnValue({
    roleDefaults: {},
    cliInventory: undefined,
    showCliPicker: true,
    refreshDesktopSettings: vi.fn(),
  });
  hooks.useDesktopProject.mockReturnValue(vi.fn());
  hooks.useOnboarding.mockReturnValue({
    open: false,
    status: undefined,
    busy: false,
    error: undefined,
    save: vi.fn(),
    skip: vi.fn(),
    reopen: vi.fn(),
  });
  hooks.useThemeMode.mockReturnValue({ themeMode: "dark", cycleTheme: vi.fn() });
});

describe("App shell", () => {
  it("shows the loading shell until the workspace answers", async () => {
    let resolve!: (value: WorkspaceInfo) => void;
    hooks.getWorkspace.mockReturnValue(new Promise<WorkspaceInfo>((done) => (resolve = done)));
    render(<App />);
    expect(screen.getByText("Agent Team")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/连接控制服务/);

    resolve(workspace());
    await waitFor(() => expect(screen.queryByText("连接控制服务…")).toBeNull());
  });

  it("reports a workspace failure through the shared error channel", async () => {
    const setError = vi.fn();
    hooks.useRunEvents.mockReturnValue(monitor({ setError }));
    hooks.getWorkspace.mockRejectedValue(new Error("workspace unavailable"));
    render(<App />);
    await waitFor(() => expect(setError).toHaveBeenCalled());
    expect(String(setError.mock.calls[0]?.[0])).toContain("unavailable");
  });

  it("renders the board once the workspace loads", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/tighten the quality gate/)).toBeTruthy());
  });

  it("opens the launcher with N and the palette with ⌘K", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/tighten the quality gate/)).toBeTruthy());

    await userEvent.keyboard("n");
    expect(await screen.findByText("启动 Agent 团队")).toBeVisible();

    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("shows a dismissible error toast", async () => {
    const setError = vi.fn();
    hooks.useRunEvents.mockReturnValue(monitor({ error: "boom", setError }));
    render(<App />);
    const toast = await screen.findByRole("alert");
    expect(toast).toHaveTextContent("boom");

    await userEvent.click(screen.getByRole("button", { name: "关闭错误" }));
    expect(setError).toHaveBeenCalledWith(undefined);
  });


});
