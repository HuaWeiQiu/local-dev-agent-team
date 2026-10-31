// @vitest-environment jsdom
import "./dom-setup.js";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  publishRun: vi.fn(),
  deleteRun: vi.fn(),
  respondApproval: vi.fn(),
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  previewRunCleanup: vi.fn(),
  cleanupRuns: vi.fn(),
  getEvidenceFile: vi.fn(),
  downloadRunEvents: vi.fn(),
  preflightStrategyBlueprint: vi.fn(),
  saveStrategyBlueprint: vi.fn(),
  deleteStrategyBlueprint: vi.fn(),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { useRunActions } = await import("../../web/src/hooks/useRunActions.js");

const scope = { mode: "single", projectId: "p1" } as never;

function summary(id: string): RunSummary {
  return { id, goal: `goal ${id}`, status: "completed", taskCounts: {} } as unknown as RunSummary;
}

function harness() {
  const monitor = {
    runs: [summary("r-1")],
    selectedRunId: "r-1",
    setSelectedRunId: vi.fn(),
    setRun: vi.fn(),
    setEvents: vi.fn(),
    setEvidence: vi.fn(),
    setError: vi.fn(),
    refreshRuns: vi.fn().mockResolvedValue(undefined),
    refreshRun: vi.fn().mockResolvedValue(undefined),
    refreshConfig: vi.fn().mockResolvedValue({}),
  };
  const ui = {
    setMonitorPanel: vi.fn(),
    setMonitorView: vi.fn(),
    setWorkspaceMode: vi.fn(),
    setLauncherOpen: vi.fn(),
    setLauncherStrategy: vi.fn(),
  };
  const view = renderHook(() => useRunActions({ scope, monitor: monitor as never, ...ui }));
  return { view, monitor, ui };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.startRun.mockResolvedValue("new-run");
  api.cancelRun.mockResolvedValue(undefined);
  api.retryRun.mockResolvedValue("retry-run");
  api.publishRun.mockResolvedValue({ pullRequestUrl: "http://pr/1" });
  api.deleteRun.mockResolvedValue(undefined);
  api.respondApproval.mockResolvedValue(undefined);
  api.pauseRun.mockResolvedValue(undefined);
  api.resumeRun.mockResolvedValue(undefined);
  api.previewRunCleanup.mockResolvedValue({ token: "t", runs: [] });
  api.cleanupRuns.mockResolvedValue(undefined);
  api.getEvidenceFile.mockResolvedValue({ content: "x" });
  api.downloadRunEvents.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "open").mockImplementation(() => null);
});

describe("useRunActions", () => {
  it("creates a run and moves the UI into the run monitor", async () => {
    const { view, monitor, ui } = harness();
    let started = false;
    await act(async () => {
      started = await view.result.current.create({ goal: "do it" } as never);
    });
    expect(started).toBe(true);
    expect(api.startRun).toHaveBeenCalledWith(scope, { goal: "do it" });
    expect(monitor.setSelectedRunId).toHaveBeenCalledWith("new-run");
    expect(ui.setMonitorPanel).toHaveBeenCalledWith("activity");
    expect(ui.setWorkspaceMode).toHaveBeenCalledWith("monitor");
    expect(view.result.current.busy).toBe(false);
  });

  it("keeps the launcher open and reports a failed start", async () => {
    api.startRun.mockRejectedValue(new Error("spawn failed"));
    const { view, monitor, ui } = harness();
    let started = true;
    await act(async () => {
      started = await view.result.current.create({ goal: "do it" } as never);
    });
    expect(started).toBe(false);
    expect(ui.setLauncherOpen).not.toHaveBeenCalled();
    expect(String(monitor.setError.mock.calls.at(-1)?.[0] ?? "")).toContain("spawn failed");
  });

  it("cancels, retries, publishes and exports", async () => {
    const { view, monitor } = harness();
    await act(async () => {
      await view.result.current.cancel();
      await view.result.current.retry();
      await view.result.current.publish();
      await view.result.current.exportRunEvents();
    });
    expect(api.cancelRun).toHaveBeenCalledWith(scope, "r-1");
    expect(api.retryRun).toHaveBeenCalledWith(scope, "r-1");
    expect(monitor.setSelectedRunId).toHaveBeenCalledWith("retry-run");
    expect(api.publishRun).toHaveBeenCalledWith(scope, "r-1");
    expect(window.open).toHaveBeenCalledWith("http://pr/1", "_blank", "noopener");
    expect(api.downloadRunEvents).toHaveBeenCalledWith(scope, "r-1");
  });

  it("deletes a run only after confirmation", async () => {
    const { view, monitor } = harness();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => {
      await view.result.current.handleDeleteRun("r-1");
    });
    expect(api.deleteRun).not.toHaveBeenCalled();

    await act(async () => {
      await view.result.current.handleDeleteRun("r-1");
    });
    expect(api.deleteRun).toHaveBeenCalledWith(scope, "r-1");
    expect(monitor.setSelectedRunId).toHaveBeenCalledWith(undefined);
  });

  it("submits approval, pause and resume actions", async () => {
    const { view } = harness();
    const input = { actor: "op", reason: "why", decision: "approved" as const };

    act(() => view.result.current.setRunAction({ mode: "approval", approval: { id: "a-1" } as never }));
    await act(async () => {
      await view.result.current.submitRunAction(input);
    });
    expect(api.respondApproval).toHaveBeenCalledWith(scope, "r-1", {
      requestId: "a-1",
      decision: "approved",
      actor: "op",
      reason: "why",
    });

    act(() => view.result.current.setRunAction({ mode: "pause" }));
    await act(async () => {
      await view.result.current.submitRunAction(input);
    });
    expect(api.pauseRun).toHaveBeenCalledWith(scope, "r-1", { actor: "op", reason: "why" });

    act(() => view.result.current.setRunAction({ mode: "resume" }));
    await act(async () => {
      await view.result.current.submitRunAction(input);
    });
    expect(api.resumeRun).toHaveBeenCalledWith(scope, "r-1", { actor: "op", reason: "why" });
  });

  it("previews and confirms a cleanup", async () => {
    const { view, monitor } = harness();
    await act(async () => {
      await view.result.current.previewCleanup(30);
    });
    expect(api.previewRunCleanup).toHaveBeenCalledWith(scope, 30);
    expect(view.result.current.cleanupPreview).toBeTruthy();

    await act(async () => {
      await view.result.current.confirmCleanup();
    });
    expect(api.cleanupRuns).toHaveBeenCalledWith(scope, "t");
    expect(monitor.setRun).toHaveBeenCalledWith(undefined);
    expect(view.result.current.cleanupOpen).toBe(false);
  });

  it("saves and deletes strategy blueprints through the config refresher", async () => {
    api.preflightStrategyBlueprint.mockResolvedValue({ ok: true });
    api.saveStrategyBlueprint.mockResolvedValue({ ok: true });
    api.deleteStrategyBlueprint.mockResolvedValue(undefined);
    const { view, monitor } = harness();
    await act(async () => {
      await view.result.current.preflightBlueprint("b", {} as never);
      await view.result.current.saveBlueprint("b", {} as never);
      await view.result.current.deleteBlueprint("b");
    });
    expect(monitor.refreshConfig).toHaveBeenCalledTimes(2);
  });

  it("reads an evidence artifact and refuses without a run", async () => {
    const { view } = harness();
    await act(async () => {
      await view.result.current.readEvidenceArtifact("logs/a.txt");
    });
    expect(api.getEvidenceFile).toHaveBeenCalledWith(scope, "r-1", "logs/a.txt");

    const idleMonitor = {
      runs: [],
      selectedRunId: undefined,
      setSelectedRunId: vi.fn(),
      setRun: vi.fn(),
      setEvents: vi.fn(),
      setEvidence: vi.fn(),
      setError: vi.fn(),
      refreshRuns: vi.fn().mockResolvedValue(undefined),
      refreshRun: vi.fn().mockResolvedValue(undefined),
      refreshConfig: vi.fn().mockResolvedValue({}),
    };
    const bare = renderHook(() =>
      useRunActions({
        scope,
        monitor: idleMonitor as never,
        setMonitorPanel: vi.fn(),
        setMonitorView: vi.fn(),
        setWorkspaceMode: vi.fn(),
        setLauncherOpen: vi.fn(),
        setLauncherStrategy: vi.fn(),
      }),
    );
    await expect(bare.result.current.readEvidenceArtifact("x")).rejects.toThrow(/尚未加载/);
  });
});
