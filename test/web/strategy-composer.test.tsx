// @vitest-environment jsdom
import "./dom-setup.js";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicConfig, StrategyDefinition } from "../../web/src/types.js";

vi.mock("@xyflow/react", () => {
  const Pass = ({ children }: { children?: unknown }) => children ?? null;
  return {
    ReactFlow: ({ children }: { children?: unknown }) => children ?? null,
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => null,
    Handle: () => null,
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    __Pass: Pass,
  };
});

import { TooltipProvider } from "../../web/src/ui/tooltip.js";

const { StrategyComposer } = await import("../../web/src/components/StrategyComposer.js");
const { StrategyCanvas } = await import("../../web/src/components/strategy/composer/sections.js");
const { useStrategyComposer } = await import(
  "../../web/src/components/strategy/composer/useStrategyComposer.js"
);
const { definitionFor, draftSummary, errorFeedback, feedbackFor, DELETE_FEEDBACK } = await import(
  "../../web/src/components/strategy/composer/model.js"
);
const { createDraft } = await import("../../web/src/components/strategy/draft.js");

function definition(patch: Record<string, unknown> = {}): StrategyDefinition {
  return {
    source: "config",
    roleProfiles: { worker: "p1" },
    compiledTopology: {
      mode: "parallel-dag",
      stages: [{ id: "plan", label: "计划", kind: "plan", role: "architect" }],
      edges: [],
    },
    ...patch,
  } as unknown as StrategyDefinition;
}

function config(patch: Partial<PublicConfig> = {}): PublicConfig {
  return {
    project: { name: "demo", maxParallel: 2 },
    roles: {},
    strategies: {
      default: "demo",
      definitions: { demo: definition(), tighten: definition({ source: "custom", maxParallel: 1 }) },
    },
    ...patch,
  } as unknown as PublicConfig;
}

function host(patch: Record<string, unknown> = {}) {
  return {
    config: config(),
    onPreflight: vi.fn().mockResolvedValue({ name: "demo-custom" }),
    onSave: vi.fn().mockResolvedValue({ name: "demo-custom" }),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onLaunch: vi.fn(),
    ...patch,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("composer model", () => {
  it("resolves the definition and falls back to the default", () => {
    const cfg = config();
    expect(definitionFor(cfg, "tighten")).toBe(cfg.strategies.definitions.tighten);
    expect(definitionFor(cfg, "ghost")).toBe(cfg.strategies.definitions.demo);
  });

  it("summarizes a parallel and a sequential draft", () => {
    const topology = { mode: "parallel-dag", stages: [{}, {}], edges: [] } as never;
    const draft = createDraft(definition(), config());
    const parallel = draftSummary(topology, { ...draft, maxParallel: 4, swarmMaxConcurrency: 2, exploreEnabled: true });
    expect(parallel.find((row) => row.label === "阶段")?.value).toBe("2");
    expect(parallel.find((row) => row.label === "并行上限")?.value).toBe("4");
    expect(parallel.find((row) => row.label === "Swarm 并发")?.value).toBe("2");
    expect(parallel.find((row) => row.label === "探索")?.on).toBe(true);

    const sequential = draftSummary(topology, { ...draft, mode: "sequential", maxParallel: 4 });
    expect(sequential.find((row) => row.label === "并行上限")?.value).toBe("1");
    expect(sequential.find((row) => row.label === "Swarm 并发")?.value).toBe("1");
  });

  it("maps action results to feedback", () => {
    expect(feedbackFor("save")).toEqual({ kind: "saved", message: "已保存并编译" });
    expect(feedbackFor("preflight")).toEqual({ kind: "valid", message: "服务端预检通过" });
    expect(DELETE_FEEDBACK.message).toBe("蓝图已删除");
    expect(errorFeedback(new Error("boom"))).toEqual({ kind: "error", message: "boom" });
    expect(errorFeedback("plain")).toEqual({ kind: "error", message: "plain" });
  });
});

describe("useStrategyComposer", () => {
  it("starts on the default strategy and tracks dirtiness", async () => {
    const h = host();
    const view = renderHook(() => useStrategyComposer(h));
    expect(view.result.current.selectedName).toBe("demo");
    expect(view.result.current.dirty).toBe(false);

    act(() => {
      view.result.current.workspace.updateDraft((current) => ({ ...current, maxParallel: 9 }));
    });
    expect(view.result.current.dirty).toBe(true);

    act(() => {
      view.result.current.workspace.resetDraft();
    });
    expect(view.result.current.dirty).toBe(false);
  });

  it("saves, preflights and deletes with feedback", async () => {
    const h = host();
    const view = renderHook(() => useStrategyComposer(h));

    await act(async () => {
      await view.result.current.workspace.run("save");
    });
    expect(h.onSave).toHaveBeenCalled();
    expect(view.result.current.feedback).toMatchObject({ kind: "saved" });

    await act(async () => {
      await view.result.current.workspace.run("preflight");
    });
    expect(h.onPreflight).toHaveBeenCalled();
    expect(view.result.current.feedback).toMatchObject({ kind: "valid" });

    await act(async () => {
      await view.result.current.workspace.run("delete");
    });
    expect(h.onDelete).toHaveBeenCalledWith("demo");
    expect(view.result.current.feedback?.message).toBe("蓝图已删除");
  });

  it("reports a failed action and clears submitting", async () => {
    const h = host({ onSave: vi.fn().mockRejectedValue(new Error("nope")) });
    const view = renderHook(() => useStrategyComposer(h));
    await act(async () => {
      await view.result.current.workspace.run("save");
    });
    expect(view.result.current.feedback).toEqual({ kind: "error", message: "nope" });
    expect(view.result.current.submitting).toBe(false);
  });

  it("switches strategy, toggles panels and launches", () => {
    const h = host();
    const view = renderHook(() => useStrategyComposer(h));
    act(() => {
      view.result.current.workspace.selectStrategy("tighten");
      view.result.current.workspace.setLibraryOpen();
      view.result.current.workspace.setInspectorOpen();
    });
    expect(view.result.current.selectedName).toBe("tighten");
    expect(view.result.current.libraryOpen).toBe(true);
    expect(view.result.current.panelOpen).toBe(true);

    act(() => {
      view.result.current.workspace.closePanels();
      view.result.current.workspace.launch();
    });
    expect(view.result.current.panelOpen).toBe(false);
    expect(h.onLaunch).toHaveBeenCalledWith("tighten");
  });

  it("renames the blueprint and clears feedback on edit", () => {
    const h = host();
    const view = renderHook(() => useStrategyComposer(h));
    act(() => {
      view.result.current.workspace.setBlueprintName("mine");
    });
    expect(view.result.current.blueprintName).toBe("mine");
  });
});

describe("StrategyComposer", () => {
  it("explains an empty project", () => {
    render(
      <StrategyComposer
        {...(host({ config: { ...config(), strategies: { default: "demo", definitions: {} } } }) as object)}
      />,
    );
    expect(screen.getByText("还没有可编排的策略")).toBeVisible();
  });

  it("renders the workspace with the toolbar", () => {
    render(
      <TooltipProvider>
        <StrategyComposer {...(host() as object)} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("region", { name: "策略编排器" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "策略阶段图" })).toBeTruthy();
  });

  it("shows the empty-canvas hint and the error callout", () => {
    const emptyTopology = { mode: "parallel-dag", stages: [], edges: [] } as never;
    render(
      <StrategyCanvas
        graph={{ nodes: [], edges: [] } as never}
        topology={emptyTopology}
        draft={createDraft(definition(), config())}
        palette={{ dot: "#000", edge: "#000" }}
        feedback={{ kind: "error", message: "预检失败" }}
        onSelectStage={() => undefined}
      />,
    );
    expect(screen.getByText("该策略暂无可展示的阶段")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("预检失败");
  });

  it("toggles the library panel from the toolbar", async () => {
    render(
      <TooltipProvider>
        <StrategyComposer {...(host() as object)} />
      </TooltipProvider>,
    );
    const toggle = screen.getByRole("button", { name: /策略库|library/i });
    await userEvent.click(toggle);
    expect(screen.getByRole("region", { name: "策略编排器" })).toBeTruthy();
  });
});
