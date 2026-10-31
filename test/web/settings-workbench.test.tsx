// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CliInventory,
  DesktopSettingsResponse,
  DesktopSettingsView,
} from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  getDesktopSettings: vi.fn(),
  getProjectRoleSettings: vi.fn(),
  saveDesktopSettings: vi.fn(),
  saveProjectRoleSettings: vi.fn(),
  scanCliInventory: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { SettingsWorkbench } = await import("../../web/src/components/SettingsWorkbench.js");

export function inventory(): CliInventory {
  return {
    scannedAt: "2026-10-30T00:00:00.000Z",
    home: "/home/tester",
    clis: [
      {
        id: "kimi",
        binary: "/opt/homebrew/bin/kimi",
        installed: true,
        version: "kimi 1.0.0",
        auth: { status: "present" },
        configPaths: [],
        models: [{ id: "m1", label: "m1", reasoningOptions: ["high"] }],
        defaultModel: "m1",
        defaultReasoning: "high",
        runtimeSupported: true,
      },
      {
        id: "grok",
        installed: false,
        auth: { status: "invalid", detail: "授权文件已过期" },
        configPaths: [],
        models: [],
        runtimeSupported: false,
      },
      {
        id: "codex",
        installed: true,
        auth: { status: "missing" },
        configPaths: [],
        models: [],
        runtimeSupported: true,
      },
    ],
  };
}

function settings(): DesktopSettingsView {
  return {
    version: 1,
    defaults: { roles: { worker: { cli: "kimi", model: "m1", reasoning: "high" } } },
    ui: {
      showCliPickerInRunLauncher: true,
      autoDetectCliConfig: true,
      autoDetectOnFocus: true,
    },
    inventoryCachedAt: "2026-10-30T00:00:00.000Z",
  };
}

function response(patch: Partial<DesktopSettingsResponse> = {}): DesktopSettingsResponse {
  return {
    settings: settings(),
    inventory: inventory(),
    fromCache: true,
    reason: "hit",
    suggestedDefaults: { worker: { cli: "kimi", model: "m1", reasoning: "high" } },
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getDesktopSettings.mockResolvedValue(response());
  api.scanCliInventory.mockResolvedValue({ inventory: inventory(), reason: "refresh" });
  api.saveDesktopSettings.mockResolvedValue({ settings: settings() });
  api.getProjectRoleSettings.mockResolvedValue({
    projectId: "p1",
    projectName: "demo",
    effective: { worker: { cli: "grok", reasoning: "high" } },
    sources: { worker: "project" },
    overrides: { worker: { cli: "grok", reasoning: "high" } },
  });
  api.saveProjectRoleSettings.mockResolvedValue({
    projectId: "p1",
    projectName: "demo",
    effective: {},
    sources: {},
    overrides: {},
  });
});

describe("SettingsWorkbench", () => {
  it("renders the global pane with the detected CLI list", async () => {
    render(<SettingsWorkbench />);
    expect(await screen.findByRole("heading", { name: "Agent CLI 与角色默认" })).toBeVisible();
    expect(screen.getAllByText("Kimi").length).toBeGreaterThan(0);
    expect(screen.getByText("已配置授权")).toBeVisible();
    expect(screen.getByText(/缓存（配置未变）/)).toBeVisible();
  });

  it("forces a rescan and reports it", async () => {
    render(<SettingsWorkbench />);
    await screen.findByRole("heading", { name: "Agent CLI 与角色默认" });

    await userEvent.click(screen.getByRole("button", { name: "立即手动检测" }));
    await waitFor(() => expect(api.scanCliInventory).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已强制重新检索本机 CLI 配置")).toBeVisible();
  });

  it("saves the global defaults including the UI toggles", async () => {
    const onSaved = vi.fn();
    render(<SettingsWorkbench onSaved={onSaved} />);
    await screen.findByRole("heading", { name: "Agent CLI 与角色默认" });

    await userEvent.click(screen.getByRole("checkbox", { name: /新建运行时可选择 CLI/ }));
    await userEvent.click(screen.getByRole("button", { name: /保存全局/ }));

    await waitFor(() => expect(api.saveDesktopSettings).toHaveBeenCalledTimes(1));
    expect(api.saveDesktopSettings.mock.calls[0]?.[0]).toMatchObject({
      defaults: { roles: { worker: { cli: "kimi", model: "m1", reasoning: "high" } } },
      ui: { showCliPickerInRunLauncher: false },
    });
    expect(await screen.findByText("全局默认已保存（仅本机，不写进项目仓库）")).toBeVisible();
    expect(onSaved).toHaveBeenCalled();
  });

  it("saves project overrides as a per-role payload", async () => {
    render(
      <SettingsWorkbench
        pane="project"
        scope={{ id: "p1", name: "demo", root: "/repo" }}
        projectName="demo"
      />,
    );
    expect(await screen.findByRole("heading", { name: "项目角色覆盖" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /保存项目/ }));
    await waitFor(() => expect(api.saveProjectRoleSettings).toHaveBeenCalledTimes(1));
    expect(api.saveProjectRoleSettings.mock.calls[0]?.[1]).toMatchObject({
      worker: { cli: "grok", reasoning: "high" },
    });
    expect(await screen.findByText(/项目角色已保存/)).toBeVisible();
  });
});
