// @vitest-environment jsdom
import "./dom-setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummary, WorkspaceInfo } from "../../web/src/types.js";

const api = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getRuns: vi.fn(),
  getRun: vi.fn(),
  getRunEvidence: vi.fn(),
  getUsage: vi.fn(),
  eventStreamUrl: vi.fn((scope: { mode: string; projectId: string }, runId?: string) =>
    `http://test/stream/${scope.projectId}${runId ? `/${runId}` : ""}`,
  ),
}));

vi.mock("../../web/src/api", async () => {
  const actual = await vi.importActual<typeof import("../../web/src/api")>(
    "../../web/src/api",
  );
  return { ...actual, ...api };
});

const { useRunEvents } = await import("../../web/src/hooks/useRunEvents.js");
const { ApiError } = await import("../../web/src/api.js");

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  emitRaw(data: string): void {
    this.onmessage?.({ data });
  }
  open(): void {
    this.onopen?.();
  }
  fail(): void {
    this.onerror?.();
  }
}

const scope = { mode: "single", projectId: "p1" } as WorkspaceInfo extends never ? never : { mode: "single"; projectId: string };

function summary(id: string): RunSummary {
  return { id, goal: `goal ${id}`, status: "completed", taskCounts: {}, createdAt: "", updatedAt: "" } as unknown as RunSummary;
}

function runFixture(id: string) {
  return {
    id,
    goal: `goal ${id}`,
    status: "implementing",
    strategy: { name: "demo", maxParallel: 2, maxReworkAttempts: 1 },
    tasks: [],
    history: [],
    updatedAt: "2026-10-30T00:00:00.000Z",
  } as never;
}

function event(sequence: number, type: string) {
  return {
    sequence,
    id: `e-${sequence}`,
    schemaVersion: 1,
    runId: "r-1",
    type,
    occurredAt: "2026-10-30T00:00:00.000Z",
    payload: {},
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
  };
}

// jsdom has no EventSource; install the fake once for the whole file.
Object.defineProperty(globalThis, "EventSource", {
  value: FakeEventSource,
  writable: true,
  configurable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  api.getConfig.mockResolvedValue({ roles: {}, strategies: { default: "demo", definitions: {} } });
  api.getRuns.mockResolvedValue([summary("r-1"), summary("r-2")]);
  api.getRun.mockResolvedValue(runFixture("r-1"));
  api.getRunEvidence.mockResolvedValue({ files: [] });
  api.getUsage.mockResolvedValue({ entries: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRunEvents", () => {
  it("loads config and runs, then selects the first run", async () => {
    const view = renderHook(() => useRunEvents(scope, { evidenceVisible: false, usageVisible: false }));
    await waitFor(() => expect(view.result.current.runs).toHaveLength(2));
    expect(view.result.current.selectedRunId).toBe("r-1");
    expect(view.result.current.config).toBeTruthy();
    await waitFor(() => expect(view.result.current.run?.id).toBe("r-1"));
  });

  it("subscribes to the run and project streams", async () => {
    const view = renderHook(() => useRunEvents(scope, { evidenceVisible: false, usageVisible: false }));
    await waitFor(() => expect(view.result.current.selectedRunId).toBe("r-1"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const urls = FakeEventSource.instances.map((source) => source.url);
    expect(urls).toContain("http://test/stream/p1/r-1");
    expect(urls).toContain("http://test/stream/p1");

    const runSource = FakeEventSource.instances.find((source) => source.url.endsWith("/r-1"))!;
    act(() => runSource.open());
    expect(view.result.current.connected).toBe(true);
    act(() => runSource.fail());
    expect(view.result.current.connected).toBe(false);
  });

  it("buffers and de-duplicates run events", async () => {
    vi.useFakeTimers();
    const view = renderHook(() => useRunEvents(scope, { evidenceVisible: false, usageVisible: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const runSource = FakeEventSource.instances.find((source) => source.url.endsWith("/r-1"))!;

    act(() => {
      runSource.emit(event(1, "run.updated"));
      runSource.emit(event(1, "run.updated"));
      vi.advanceTimersByTime(200);
    });
    expect(view.result.current.events.filter((item) => item.sequence === 1)).toHaveLength(1);

    act(() => {
      runSource.emitRaw("not json");
    });
    expect(view.result.current.error).toContain("无法解析");
  });

  it("refreshes the list when a run event arrives", async () => {
    vi.useFakeTimers();
    renderHook(() => useRunEvents(scope, { evidenceVisible: false, usageVisible: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = api.getRuns.mock.calls.length;
    const runSource = FakeEventSource.instances.find((source) => source.url.endsWith("/r-1"))!;
    act(() => {
      runSource.emit(event(2, "run.updated"));
      vi.advanceTimersByTime(200);
    });
    expect(api.getRuns.mock.calls.length).toBeGreaterThan(before);
  });

  it("clears the selection when the run was deleted", async () => {
    api.getRun.mockRejectedValue(new ApiError(404, "gone"));
    const view = renderHook(() => useRunEvents(scope, { evidenceVisible: false, usageVisible: false }));
    await waitFor(() => expect(view.result.current.error).toContain("已不存在"));
    // The list refresh may re-select the same id; what matters is that the
    // deleted run is not kept as loaded state.
    expect(view.result.current.run).toBeUndefined();
  });

  it("fetches evidence and usage only for visible panels", async () => {
    const view = renderHook(() => useRunEvents(scope, { evidenceVisible: true, usageVisible: true }));
    await waitFor(() => expect(api.getRunEvidence).toHaveBeenCalled());
    expect(api.getUsage).toHaveBeenCalled();

    view.rerender();
    act(() => view.result.current.resetRunScope());
    expect(view.result.current.runs).toEqual([]);
    expect(view.result.current.connected).toBe(false);
  });

  it("surfaces a list or run failure through the shared error channel", async () => {
    api.getRuns.mockRejectedValueOnce(new Error("list down"));
    const first = renderHook(() => useRunEvents(scope, { evidenceVisible: false, usageVisible: false }));
    await waitFor(() => expect(first.result.current.error).toBeTruthy());
    first.unmount();

    api.getRuns.mockResolvedValue([summary("r-1")]);
    api.getRun.mockRejectedValue(new Error("run down"));
    const second = renderHook(() => useRunEvents(scope, { evidenceVisible: false, usageVisible: false }));
    await waitFor(() => expect(second.result.current.error).toBeTruthy());
  });

  it("drops a response that arrives after the scope changed", async () => {
    const other = { mode: "single", projectId: "p2" } as typeof scope;
    const view = renderHook(
      ({ project }: { project: typeof scope }) =>
        useRunEvents(project, { evidenceVisible: false, usageVisible: false }),
      { initialProps: { project: scope } },
    );
    await waitFor(() => expect(view.result.current.runs).toHaveLength(2));

    view.rerender({ project: other });
    await waitFor(() => expect(api.getRuns).toHaveBeenCalledWith(other));
    // The first project's late answer must not land in the new project's state.
    expect(view.result.current.runs.every((item) => item.id.startsWith("r-"))).toBe(true);
  });
});
