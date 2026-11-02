// @vitest-environment jsdom
import "./dom-setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getDesktopSettings: vi.fn(),
  getProjectRoleSettings: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { useDesktopSettings } = await import("../../web/src/hooks/useDesktopSettings.js");

const scope = { mode: "single" as const, projectId: "project-1" };

const binding = (role: string) => ({
  role,
  adapter: "codex" as const,
  model: "inherit",
  reasoning: "high" as const,
  permission: "workspace-write" as const,
  externalTools: "inherit" as const,
});

function settings(patch: {
  showCliPicker?: boolean;
  autoDetectCliConfig?: boolean;
  autoDetectOnFocus?: boolean;
} = {}) {
  return {
    settings: {
      defaults: { roles: { worker: binding("worker") } },
      ui: {
        showCliPickerInRunLauncher: patch.showCliPicker ?? true,
        autoDetectCliConfig: patch.autoDetectCliConfig ?? true,
        autoDetectOnFocus: patch.autoDetectOnFocus ?? true,
      },
    },
    inventory: { tools: [], generatedAt: "2026-11-02T00:00:00.000Z" },
    fromCache: false,
    suggestedDefaults: {},
  };
}

function projectRoles(effective: Record<string, unknown>) {
  return {
    projectId: "project-1",
    projectName: "Project",
    roles: {},
    global: {},
    effective,
    sources: {},
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDesktopSettings", () => {
  it("prefers the project's effective role bindings over the global defaults", async () => {
    api.getDesktopSettings.mockResolvedValue(settings());
    api.getProjectRoleSettings.mockResolvedValue(projectRoles({ worker: binding("worker") }));

    const { result } = renderHook(() => useDesktopSettings(scope));

    await waitFor(() => expect(result.current.cliInventory).toBeDefined());
    expect(api.getProjectRoleSettings).toHaveBeenCalledWith(scope);
    expect(result.current.roleDefaults).toEqual({ worker: binding("worker") });
    expect(result.current.showCliPicker).toBe(true);
  });

  it("falls back to the global defaults when the project route fails", async () => {
    api.getDesktopSettings.mockResolvedValue(settings());
    api.getProjectRoleSettings.mockRejectedValue(new Error("404"));

    const { result } = renderHook(() => useDesktopSettings(scope));

    await waitFor(() => expect(result.current.cliInventory).toBeDefined());
    expect(result.current.roleDefaults).toEqual({ worker: binding("worker") });
  });

  it("reads the global defaults when no project is open", async () => {
    api.getDesktopSettings.mockResolvedValue(settings());

    const { result } = renderHook(() => useDesktopSettings(undefined));

    await waitFor(() => expect(result.current.cliInventory).toBeDefined());
    expect(api.getProjectRoleSettings).not.toHaveBeenCalled();
    expect(result.current.roleDefaults).toEqual({ worker: binding("worker") });
  });

  it("honours the ui flags for the picker and the focus refresh", async () => {
    api.getDesktopSettings.mockResolvedValue(
      settings({ showCliPicker: false, autoDetectCliConfig: false }),
    );

    const { result } = renderHook(() => useDesktopSettings(undefined));

    await waitFor(() => expect(result.current.cliInventory).toBeDefined());
    expect(result.current.showCliPicker).toBe(false);
  });

  it("keeps the picker on when the server sends no explicit choice", async () => {
    const response = settings();
    delete (response.settings.ui as { showCliPickerInRunLauncher?: boolean })
      .showCliPickerInRunLauncher;
    api.getDesktopSettings.mockResolvedValue(response);

    const { result } = renderHook(() => useDesktopSettings(undefined));

    await waitFor(() => expect(result.current.cliInventory).toBeDefined());
    expect(result.current.showCliPicker).toBe(true);
  });

  it("swallows a settings read that the browser cannot make", async () => {
    api.getDesktopSettings.mockRejectedValue(new Error("401"));

    const { result } = renderHook(() => useDesktopSettings(undefined));

    await waitFor(() => expect(api.getDesktopSettings).toHaveBeenCalled());
    expect(result.current.roleDefaults).toEqual({});
    expect(result.current.cliInventory).toBeUndefined();
  });

  it("rescans when the window becomes visible again", async () => {
    api.getDesktopSettings.mockResolvedValue(settings());
    const { result } = renderHook(() => useDesktopSettings(undefined));
    await waitFor(() => expect(result.current.cliInventory).toBeDefined());
    expect(api.getDesktopSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(api.getDesktopSettings).toHaveBeenCalledTimes(2));
  });

  it("rescans when the document becomes visible", async () => {
    api.getDesktopSettings.mockResolvedValue(settings());
    const { result } = renderHook(() => useDesktopSettings(undefined));
    await waitFor(() => expect(result.current.cliInventory).toBeDefined());

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } finally {
      visibility.mockRestore();
    }

    await waitFor(() => expect(api.getDesktopSettings).toHaveBeenCalledTimes(2));
  });

  it("does not listen for focus when the operator turned the check off", async () => {
    api.getDesktopSettings.mockResolvedValue(settings({ autoDetectOnFocus: false }));
    const { result } = renderHook(() => useDesktopSettings(undefined));
    await waitFor(() => expect(result.current.cliInventory).toBeDefined());

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(api.getDesktopSettings).toHaveBeenCalledTimes(1);
  });

  it("stops listening once the hook unmounts", async () => {
    api.getDesktopSettings.mockResolvedValue(settings());
    const { result, unmount } = renderHook(() => useDesktopSettings(undefined));
    await waitFor(() => expect(result.current.cliInventory).toBeDefined());
    unmount();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(api.getDesktopSettings).toHaveBeenCalledTimes(1);
  });
});
