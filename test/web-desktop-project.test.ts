import { describe, expect, it, vi } from "vitest";
import {
  addDesktopProjectFlow,
  type DesktopProjectPorts,
} from "../web/src/hooks/useDesktopProject.js";

function ports(overrides: Partial<DesktopProjectPorts> = {}): DesktopProjectPorts & {
  calls: Array<[string, unknown]>;
} {
  const calls: Array<[string, unknown]> = [];
  const base = {
    openDialog: vi.fn(async () => "/repo"),
    invoke: vi.fn(async (command: string, args?: unknown) => {
      calls.push([command, args]);
      return { state: "ready", message: "ok" };
    }),
    confirm: vi.fn(() => true),
    ...overrides,
  } as unknown as DesktopProjectPorts & { calls: Array<[string, unknown]> };
  base.calls = calls;
  return base;
}

function options(patch: Record<string, unknown> = {}) {
  return {
    desktopShell: true,
    setBusy: vi.fn(),
    setError: vi.fn(),
    ...patch,
  } as never;
}

describe("addDesktopProjectFlow", () => {
  it("does nothing outside the desktop shell", async () => {
    const p = ports();
    await addDesktopProjectFlow(options({ desktopShell: false }), p);
    expect(p.openDialog).not.toHaveBeenCalled();
  });

  it("registers a folder and lets a ready shell navigate", async () => {
    const p = ports();
    const o = options() as { setBusy: ReturnType<typeof vi.fn>; setError: ReturnType<typeof vi.fn> };
    await addDesktopProjectFlow(o as never, p);
    expect(p.invoke).toHaveBeenCalledWith("desktop_open_project", { projectPath: "/repo" });
    expect(o.setError).toHaveBeenCalledWith(undefined);
    expect(o.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("stops when the picker is cancelled", async () => {
    const p = ports({ openDialog: vi.fn(async () => null) as never });
    const o = options() as { setError: ReturnType<typeof vi.fn> };
    await addDesktopProjectFlow(o as never, p);
    expect(p.invoke).not.toHaveBeenCalled();
    expect(o.setError).toHaveBeenCalledTimes(1);
  });

  it("initializes a project that needs setup", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "desktop_open_project") return { state: "needsSetup", message: "需要初始化" };
      return { state: "ready", message: "ok" };
    });
    const p = ports({ invoke: invoke as never });
    await addDesktopProjectFlow(options() as never, p);
    expect(invoke).toHaveBeenCalledWith("desktop_initialize_project");
    expect(p.confirm).toHaveBeenCalledWith(expect.stringContaining("需要初始化"));
  });

  it("restores the previous workspace when setup is declined", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "desktop_open_project") return { state: "needsSetup", message: "需要初始化" };
      return { state: "ready", message: "ok" };
    });
    const p = ports({ invoke: invoke as never, confirm: vi.fn(() => false) });
    const o = options() as { setError: ReturnType<typeof vi.fn> };
    await addDesktopProjectFlow(o as never, p);
    expect(invoke).toHaveBeenCalledWith("desktop_retry");
    expect(invoke).not.toHaveBeenCalledWith("desktop_initialize_project");
    expect(o.setError).toHaveBeenCalledTimes(1);
  });

  it("reports an error or busy status with its technical detail", async () => {
    const p = ports({
      invoke: vi.fn(async () => ({ state: "error", message: "坏了", technicalDetail: "细节" })) as never,
    });
    const o = options() as { setError: ReturnType<typeof vi.fn> };
    await addDesktopProjectFlow(o as never, p);
    expect(o.setError).toHaveBeenCalledWith("坏了\n细节");
  });

  it("explains a missing desktop permission", async () => {
    const p = ports({
      invoke: vi.fn(async () => {
        throw new Error("Command desktop_open_project not found");
      }) as never,
    });
    const o = options() as { setError: ReturnType<typeof vi.fn> };
    await addDesktopProjectFlow(o as never, p);
    expect(o.setError).toHaveBeenCalledWith(expect.stringContaining("桌面端权限未覆盖"));
  });

  it("passes other failures through the action copy", async () => {
    const p = ports({
      invoke: vi.fn(async () => {
        throw new Error("Run 'r1' was not found");
      }) as never,
    });
    const o = options() as { setError: ReturnType<typeof vi.fn> };
    await addDesktopProjectFlow(o as never, p);
    expect(o.setError).toHaveBeenCalledWith(expect.stringContaining("不存在"));
  });
});
