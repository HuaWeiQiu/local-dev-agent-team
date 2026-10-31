// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));

const { default: DesktopLauncher } = await import("../web/src/DesktopLauncher.js");
const model = await import("../web/src/desktop/launcher/model.js");
const commands = await import("../web/src/desktop/launcher/commands.js");
const hooks = await import("../web/src/desktop/launcher/useLauncherActions.js");
const { ProjectDock } = await import("../web/src/desktop/launcher/sections.js");

const {
  headline,
  launcherChecks,
  previewStatus,
  occupancyClass,
  occupancyLabel,
} = model;

function project(patch: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "示例",
    path: "/repo",
    hasConfig: true,
    ...patch,
  } as never;
}

function ports() {
  return { setStatus: vi.fn(), setBusy: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("launcher model", () => {
  it("labels occupancy for every state", () => {
    expect(occupancyLabel(project({ occupancy: "active-run" }))).toBe("有任务进行中");
    expect(occupancyLabel(project({ occupancy: "foreign" }))).toBe("其他窗口占用");
    expect(occupancyLabel(project({ occupancy: "stale" }))).toBe("残留锁可清理");
    expect(occupancyLabel(project({ occupancy: "ours" }))).toBe("本窗口管理中");
    expect(occupancyLabel(project({ occupancy: "free" }))).toBe("可打开");
    expect(occupancyLabel(project({ occupancy: "free", hasConfig: false }))).toBe("需初始化");
    expect(occupancyLabel(project({ busy: true }))).toBe("其他窗口占用");
    expect(occupancyLabel(project({ hasConfig: false }))).toBe("需初始化");
    expect(occupancyClass(project({ occupancy: "active-run" }))).toBe("is-active-run");
    expect(occupancyClass(project({ occupancy: "stale" }))).toBe("is-stale");
    expect(occupancyClass(project({ busy: true }))).toBe("is-busy");
    expect(occupancyClass(project({ occupancy: "ours" }))).toBe("is-ours");
    expect(occupancyClass(project())).toBe("is-ready");
    expect(occupancyClass(project({ hasConfig: false }))).toBe("is-setup");
  });

  it("headlines each launcher state", () => {
    expect(headline({ state: "needsProject", message: "" })).toBe("选择一个项目");
    expect(headline({ state: "needsProject", message: "", projects: [project()] })).toBe("打开或添加项目");
    expect(headline({ state: "needsSetup", message: "" })).toBe("项目需要初始化");
    expect(headline({ state: "busy", message: "" })).toBe("项目正在运行");
    expect(headline({ state: "error", message: "" })).toBe("没有打开成功");
    expect(headline({ state: "ready", message: "" })).toBe("正在进入工作台");
    expect(headline({ state: "starting", message: "" })).toBe("正在打开项目");
  });

  it("walks the three readiness checks", () => {
    const waiting = launcherChecks({ state: "needsProject", message: "" });
    expect(waiting.map((check) => check.state)).toEqual(["waiting", "waiting", "waiting"]);
    expect(waiting[0]?.detail).toBe("等待选择");

    const starting = launcherChecks({ state: "starting", message: "", projectName: "示例" });
    expect(starting.map((check) => check.state)).toEqual(["done", "done", "active"]);

    const setup = launcherChecks({ state: "needsSetup", message: "", projectName: "示例" });
    expect(setup[1]).toMatchObject({ detail: "需要初始化", state: "waiting" });

    const ready = launcherChecks({ state: "ready", message: "", projectName: "示例" });
    expect(ready[2]).toMatchObject({ detail: "已就绪", state: "done" });

    const busy = launcherChecks({ state: "busy", message: "", projectName: "示例" });
    expect(busy[2]?.detail).toBe("由另一进程管理");
  });

  it("previews every desktop state", () => {
    expect(previewStatus("needsSetup").technicalDetail).toContain("agent-team.yaml");
    expect(previewStatus("error").state).toBe("error");
    expect(previewStatus("busy").technicalDetail).toContain("PID");
    expect(previewStatus("ready").message).toBe("项目已就绪");
    expect(previewStatus("starting").message).toBe("正在检查项目");
    expect(previewStatus("needsProject").message).toContain("选择后");
  });
});

describe("launcher commands", () => {
  it("describes the release confirmation", () => {
    const lines = commands.releaseLines(project({ occupancy: "stale" }));
    expect(lines.join("\n")).toContain("陈旧锁");
    expect(lines.join("\n")).toContain("不会结束任何进程");

    const foreign = commands.releaseLines(project({ occupancy: "foreign", leasePid: 42, leaseCommand: "pnpm dev" }));
    expect(foreign.join("\n")).toContain("PID：42");
    expect(foreign.join("\n")).toContain("pnpm dev");
    expect(foreign.join("\n")).toContain("将结束占用进程");

    const active = commands.releaseLines(project({ occupancy: "active-run", hasActiveRun: true }));
    expect(active.join("\n")).toContain("进行中的 multi-agent 任务");
  });

  it("decides who may release and who shows the button", () => {
    expect(commands.isReleasable(project({ occupancy: "foreign" }))).toBe(true);
    expect(commands.isReleasable(project({ occupancy: "stale" }))).toBe(true);
    expect(commands.isReleasable(project({ occupancy: "ours" }))).toBe(false);
    expect(commands.isReleasable(project({ occupancy: "free" }))).toBe(false);
    expect(commands.showsRelease(project({ busy: true }))).toBe(true);
    expect(commands.showsRelease(project({ occupancy: "stale" }))).toBe(true);
    expect(commands.showsRelease(project())).toBe(false);
  });

  it("asks a second time when a run is still active", () => {
    expect(commands.confirmForceRelease(project({ hasActiveRun: true }))).toBe(true);
    expect(window.confirm).toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(commands.confirmForceRelease(project({ occupancy: "active-run" }))).toBe(false);
    expect(commands.confirmForceRelease(project({ occupancy: "free" }))).toBe(true);
  });

  it("rolls a failed command into the error status", async () => {
    const p = ports();
    tauri.invoke.mockRejectedValueOnce(new Error("bridge down"));
    await commands.runCommand("desktop_boot", p);
    expect(p.setBusy).toHaveBeenCalledWith(true);
    expect(p.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "error", technicalDetail: "bridge down" }),
    );
    expect(p.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("passes a successful command result through", async () => {
    const p = ports();
    tauri.invoke.mockResolvedValueOnce({ state: "ready", message: "ok" });
    await commands.runCommand("desktop_boot", p);
    expect(p.setStatus).toHaveBeenCalledWith({ state: "ready", message: "ok" });
  });
});

describe("launcher actions", () => {
  it("opens the picked folder", async () => {
    const p = ports();
    tauri.open.mockResolvedValue("/repo");
    tauri.invoke.mockResolvedValue({ state: "ready", message: "ok" });
    const { result } = renderHook(() => hooks.useProjectActions({ previewState: undefined, ports: p }));
    await result.current.chooseProject();
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_open_project", { projectPath: "/repo" });
  });

  it("ignores a cancelled picker", async () => {
    const p = ports();
    tauri.open.mockResolvedValue(null);
    const { result } = renderHook(() => hooks.useProjectActions({ previewState: undefined, ports: p }));
    await result.current.chooseProject();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("does nothing in preview mode", async () => {
    const p = ports();
    const { result } = renderHook(() => hooks.useProjectActions({ previewState: "needsSetup", ports: p }));
    await result.current.openProject("/repo");
    await result.current.removeProject(project());
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("removes a project only after confirmation", async () => {
    const p = ports();
    tauri.invoke.mockResolvedValue({ state: "ready", message: "ok" });
    const { result } = renderHook(() => hooks.useProjectActions({ previewState: undefined, ports: p }));
    await result.current.removeProject(project());
    expect(window.confirm).toHaveBeenCalled();
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_remove_project", { projectPath: "/repo" });
  });

  it("forces a release only for a foreign or stale lease", async () => {
    const p = ports();
    tauri.invoke.mockResolvedValue({ state: "ready", message: "ok" });
    const { result } = renderHook(() => hooks.useProjectActions({ previewState: undefined, ports: p }));
    await result.current.releaseLease(project({ occupancy: "ours" }));
    expect(tauri.invoke).not.toHaveBeenCalled();

    await result.current.releaseLease(project({ occupancy: "foreign", hasActiveRun: true }));
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_release_project_lease", {
      projectPath: "/repo",
      force: true,
    });
  });

  it("initializes and retries through the lifecycle hooks", async () => {
    const p = ports();
    tauri.invoke.mockResolvedValue({ state: "ready", message: "ok" });
    const { result } = renderHook(() =>
      hooks.useLifecycleActions({ previewState: undefined, ports: p }),
    );
    await result.current.initialize();
    await result.current.retry();
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_initialize_project", undefined);
    expect(tauri.invoke).toHaveBeenCalledWith("desktop_retry", undefined);
  });

  it("walks the preview path without touching the bridge", async () => {
    const p = ports();
    const { result } = renderHook(() =>
      hooks.useLifecycleActions({ previewState: "needsProject", ports: p }),
    );
    await result.current.initialize();
    expect(p.setBusy).toHaveBeenCalledWith(true);
    await result.current.retry();
    expect(p.setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "needsProject" }));
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});

describe("DesktopLauncher", () => {
  it("renders the readiness checks for a preview state", () => {
    render(<DesktopLauncher previewState="needsSetup" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("项目需要初始化");
    expect(screen.getByLabelText("准备状态")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /初始化并打开/ })).toBeTruthy();
  });

  it("offers a retry after an error", async () => {
    render(<DesktopLauncher previewState="error" />);
    expect(screen.getByText("技术详情")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("选择一个项目");
  });

  it("lists registered projects with their occupancy", () => {
    render(
      <DesktopLauncher previewState="needsProject" />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("选择一个项目");
    expect(screen.getByText(/本机/)).toBeTruthy();
  });

  it("shows the project dock with open, release and remove controls", () => {
    const onOpen = vi.fn();
    const onRelease = vi.fn();
    const onRemove = vi.fn();
    render(
      <ProjectDock
        status={{
          state: "busy",
          message: "占用中",
          projects: [
            project({ occupancy: "foreign", busy: true, leasePid: 7, leaseCommand: "pnpm dev" }),
            project({ id: "p2", name: "空闲", occupancy: "free" }),
          ],
        }}
        busy={false}
        onOpen={onOpen}
        onRelease={onRelease}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByLabelText("已注册项目")).toBeTruthy();
    expect(screen.getByText(/PID 7/)).toBeVisible();
    const release = screen.getAllByRole("button", { name: "释放占用" });
    expect(release).toHaveLength(1);
    return Promise.all([
      userEvent.click(release[0]!).then(() => expect(onRelease).toHaveBeenCalled()),
      userEvent.click(screen.getAllByRole("button", { name: /移除/ })[1]!).then(() => expect(onRemove).toHaveBeenCalled()),
      userEvent.click(screen.getAllByRole("button", { name: /示例/ })[0]!).then(() => expect(onOpen).toHaveBeenCalled()),
    ]);
  });

  it("hides the dock once a project is opening", () => {
    render(
      <ProjectDock
        status={{ state: "starting", message: "打开中", projects: [project()] }}
        busy
        onOpen={() => undefined}
        onRelease={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("已注册项目")).toBeNull();
  });
});
