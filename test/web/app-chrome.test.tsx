// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppChromeModel } from "../../web/src/app/chrome.js";
import { runState } from "../support/web-fixtures.js";

const { AppChrome } = await import("../../web/src/app/chrome.js");

function model(patch: Partial<AppChromeModel> = {}): AppChromeModel {
  const run = runState();
  return {
    workspace: {
      mode: "single",
      projects: [{ id: "p1", name: "demo", root: "/repo", hasConfig: true }],
      defaultProjectId: "p1",
    } as never,
    selectedProjectId: "p1",
    selectedProjectName: "demo",
    mode: "monitor",
    monitorView: "board",
    monitorPanel: "overview",
    config: { project: { name: "demo", maxParallel: 2 }, roles: {}, strategies: { default: "demo", definitions: {} } } as never,
    scope: { mode: "single", projectId: "p1" },
    scopeKey: "single:p1",
    monitor: { config: undefined, runs: [], run, events: [], connected: true, error: undefined, setError: vi.fn(), setSelectedRunId: vi.fn(), setSelectedTaskId: vi.fn(), resetRunScope: vi.fn(), refreshUsage: vi.fn().mockResolvedValue(undefined) } as never,
    actions: { busy: false, runAction: undefined, cleanupOpen: false, cleanupPreview: undefined, cleanupError: undefined, setBusy: vi.fn(), setRunAction: vi.fn(), setCleanupOpen: vi.fn(), setCleanupPreview: vi.fn(), setCleanupError: vi.fn(), openCleanup: vi.fn(), handleDeleteRun: vi.fn(), create: vi.fn().mockResolvedValue(true), publish: vi.fn(), cancel: vi.fn(), retry: vi.fn(), submitRunAction: vi.fn(), preflightBlueprint: vi.fn(), saveBlueprint: vi.fn(), deleteBlueprint: vi.fn(), exportRunEvents: vi.fn(), readEvidenceArtifact: vi.fn() } as never,
    onboarding: { open: false, status: undefined, busy: false, error: undefined, save: vi.fn(), skip: vi.fn(), reopen: vi.fn() } as never,
    theme: { themeMode: "dark", cycleTheme: vi.fn() } as never,
    busy: false,
    run,
    error: undefined,
    demo: false,
    desktopShell: false,
    navOpen: false,
    paletteOpen: false,
    launcherOpen: false,
    launcherStrategy: undefined,
    launcherGoal: undefined,
    roleDefaults: {},
    cliInventory: undefined,
    showCliPicker: true,
    connected: true,
    attentionCount: 0,
    paletteGroups: [],
    pendingApproval: undefined,
    handlers: {
      navigate: vi.fn(),
      selectProject: vi.fn(),
      selectRun: vi.fn(),
      selectTask: vi.fn(),
      openLauncher: vi.fn(),
      closeLauncher: vi.fn(),
      openProject: vi.fn(),
      openGlobal: vi.fn(),
      openCleanup: vi.fn(),
      deleteRun: vi.fn(),
      refreshSettings: vi.fn(),
      refreshUsage: vi.fn(),
      addProject: vi.fn(),
      cycleTheme: vi.fn(),
      setNavOpen: vi.fn(),
      setPaletteOpen: vi.fn(),
      setMonitorView: vi.fn(),
      setMonitorPanel: vi.fn(),
      setError: vi.fn(),
    },
    ...patch,
  };
}

describe("AppChrome", () => {
  it("shows the board header with the project hint", () => {
    render(<AppChrome model={model()} />);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /返回/ })).toBeNull();
  });

  it("switches the header to the run and offers the run actions", async () => {
    const handlers = model().handlers;
    render(<AppChrome model={model({ monitorView: "run", handlers })} />);
    expect(screen.getAllByRole("heading")[0]?.textContent ?? "").toContain("实现登录页");
    const back = screen.getByRole("button", { name: /返回看板/ });
    await userEvent.click(back);
    expect(handlers.setMonitorView).toHaveBeenCalledWith("board");
  });

  it("opens the launcher dialog and forwards the start request", async () => {
    const handlers = model().handlers;
    const actions = model().actions;
    render(<AppChrome model={model({ launcherOpen: true, handlers, actions })} />);
    expect(await screen.findByText("启动 Agent 团队")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(handlers.closeLauncher).toHaveBeenCalled();
  });

  it("surfaces a dismissible error toast", async () => {
    const handlers = model().handlers;
    render(<AppChrome model={model({ error: "boom", handlers })} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭错误" }));
    expect(handlers.setError).toHaveBeenCalledWith(undefined);
  });

  it("shows the demo banner and the cleanup dialog when active", () => {
    const actions = model().actions as unknown as Record<string, unknown>;
    actions.cleanupOpen = true;
    render(<AppChrome model={model({ demo: true, actions: actions as never })} />);
    expect(screen.getByText(/内置演示数据/)).toBeVisible();
  });
});
