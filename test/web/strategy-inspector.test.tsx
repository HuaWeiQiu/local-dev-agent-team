// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../web/src/ui/tooltip.js";
import { InspectorPanel } from "../../web/src/components/strategy/InspectorPanel.js";
import { createDraft } from "../../web/src/components/strategy/draft.js";
import type { PublicConfig, StrategyDefinition } from "../../web/src/types.js";

function config(): PublicConfig {
  return {
    project: { name: "demo", maxParallel: 2 },
    profiles: { fast: { label: "快速", command: "x" }, slow: { label: "稳重", command: "y" } },
    roles: {
      worker: { defaultProfile: "fast", allowedProfiles: ["fast", "slow"] },
      reviewer: { defaultProfile: "slow", allowedProfiles: ["slow"] },
    },
    strategies: { default: "demo", definitions: {} },
  } as unknown as PublicConfig;
}

function definition(patch: Record<string, unknown> = {}): StrategyDefinition {
  return {
    source: "config",
    roleProfiles: {},
    compiledTopology: { mode: "parallel-dag", stages: [], edges: [] },
    ...patch,
  } as unknown as StrategyDefinition;
}

function setup(patch: Record<string, unknown> = {}) {
  const cfg = config();
  const def = definition(patch);
  const onDraft = vi.fn();
  const props = {
    open: true,
    compact: false,
    config: cfg,
    definition: def,
    selectedName: "demo",
    draft: createDraft(def, cfg),
    blueprintName: "demo-custom",
    submitting: false,
    onBlueprintNameChange: vi.fn(),
    onDraft,
    onReset: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...patch,
  };
  render(
    <TooltipProvider>
      <InspectorPanel {...(props as never)} />
    </TooltipProvider>,
  );
  return props;
}

describe("InspectorPanel", () => {
  it("shows the blueprint name and the read-only hint for config strategies", () => {
    setup();
    expect(screen.getByText("策略属性")).toBeVisible();
    expect(screen.getByLabelText("策略蓝图名称")).toHaveValue("demo-custom");
    expect(screen.getByText(/另存为自定义蓝图/)).toBeVisible();
    expect(screen.getByText("只读配置")).toBeVisible();
  });

  it("offers delete only for a custom strategy", async () => {
    const { onDelete } = setup({ definition: definition({ source: "custom" }) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "删除自定义策略" }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("switches topology and pins parallel to one when sequential", async () => {
    const { onDraft } = setup();
    await userEvent.click(screen.getByRole("button", { name: "串行" }));
    expect(onDraft).toHaveBeenCalled();
    const patch = onDraft.mock.calls[0]?.[0]?.({ mode: "parallel-dag", maxParallel: 4 });
    expect(patch).toMatchObject({ mode: "sequential", maxParallel: 1 });
  });

  it("renders limit fields and clamps typed values", async () => {
    setup();
    const input = screen.getByLabelText("返工上限");
    await userEvent.clear(input);
    await userEvent.type(input, "99");
    expect(screen.getByLabelText("返工上限")).toBeTruthy();
  });

  it("reveals the advisor limit only when the advisor is on", async () => {
    const { unmount } = render(
      <TooltipProvider>
        <InspectorPanel
          {...({
            open: true, compact: false, config: config(), definition: definition(),
            selectedName: "demo", draft: createDraft(definition(), config()),
            blueprintName: "x", submitting: false, onBlueprintNameChange: vi.fn(), onDraft: vi.fn(),
            onReset: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
          } as never)}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByLabelText("顾问次数上限（每次运行）")).toBeNull();
    unmount();

    const cfg = config();
    const def = definition({
      taskMorphology: { advisor: { enabled: true, maxConsultationsPerRun: 2 } },
    });
    render(
      <TooltipProvider>
        <InspectorPanel
          {...({
            open: true, compact: false, config: cfg, definition: def,
            selectedName: "demo", draft: createDraft(def, cfg),
            blueprintName: "x", submitting: false, onBlueprintNameChange: vi.fn(), onDraft: vi.fn(),
            onReset: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
          } as never)}
        />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText("顾问次数上限（每次运行）")).toBeTruthy();
  });

  it("lists roles with their default profile and clears an override", async () => {
    const { onDraft } = setup();
    expect(screen.getByText("角色配置")).toBeVisible();
    const select = screen.getAllByRole("combobox")[0]!;
    await userEvent.selectOptions(select, "slow");
    expect(onDraft).toHaveBeenCalled();
  });

  it("explains when a project has no roles", () => {
    const cfg = config();
    render(
      <TooltipProvider>
        <InspectorPanel
          {...({
            open: true, compact: false, config: { ...cfg, roles: {} }, definition: definition(),
            selectedName: "demo", draft: createDraft(definition(), cfg),
            blueprintName: "x", submitting: false, onBlueprintNameChange: vi.fn(), onDraft: vi.fn(),
            onReset: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
          } as never)}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText("当前项目没有可配置的角色。")).toBeVisible();
  });
});
