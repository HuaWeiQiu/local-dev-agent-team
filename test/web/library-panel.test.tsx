// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StrategyDefinition } from "../../web/src/types.js";
import { LibraryPanel } from "../../web/src/components/strategy/LibraryPanel.js";
import { TooltipProvider } from "../../web/src/ui/tooltip.js";

function definition(patch: Partial<StrategyDefinition> = {}): StrategyDefinition {
  return {
    topology: { mode: "parallel-dag" },
    compiledTopology: { version: 1, mode: "parallel-dag", stages: [], edges: [] },
    source: "custom",
    maxParallel: 2,
    roleProfiles: {},
    ...patch,
  } as unknown as StrategyDefinition;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    open: true,
    compact: false,
    strategyNames: ["balanced", "custom-one"],
    definitions: { balanced: definition({ source: "config" }), "custom-one": definition() },
    selectedName: "balanced",
    planApproval: false,
    submitting: false,
    onSelect: vi.fn(),
    onTogglePlanApproval: vi.fn(),
    onClose: vi.fn(),
    ...patch,
  };
}

function renderPanel(element: React.ReactElement) {
  return render(<TooltipProvider>{element}</TooltipProvider>);
}

describe("LibraryPanel", () => {
  it("lists every strategy that still has a definition", () => {
    renderPanel(<LibraryPanel {...props({ strategyNames: ["balanced", "gone", "custom-one"] })} />);

    expect(screen.getByTitle("balanced")).toBeTruthy();
    expect(screen.getByTitle("custom-one")).toBeTruthy();
    expect(screen.queryByTitle("gone")).toBeNull();
  });

  it("marks the selected strategy and labels its source", () => {
    renderPanel(<LibraryPanel {...props()} />);

    expect(screen.getByTitle("balanced").getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("项目配置")).toBeTruthy();
    expect(screen.getByText("自定义蓝图")).toBeTruthy();
  });

  it("selects a strategy", () => {
    const onSelect = vi.fn();
    renderPanel(<LibraryPanel {...props({ onSelect })} />);

    fireEvent.click(screen.getByTitle("custom-one"));

    expect(onSelect).toHaveBeenCalledWith("custom-one");
  });

  it("disables the entries while submitting", () => {
    renderPanel(<LibraryPanel {...props({ submitting: true })} />);

    expect(screen.getByTitle("balanced")).toHaveProperty("disabled", true);
  });

  it("toggles the plan-approval stage and shows its state", () => {
    const onTogglePlanApproval = vi.fn();
    const { rerender } = renderPanel(<LibraryPanel {...props({ onTogglePlanApproval })} />);
    const rerenderPanel = (element: React.ReactElement) =>
      rerender(<TooltipProvider>{element}</TooltipProvider>);
    expect(screen.getByText("可添加")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /计划审批/ }));
    expect(onTogglePlanApproval).toHaveBeenCalledTimes(1);

    rerenderPanel(<LibraryPanel {...props({ onTogglePlanApproval, planApproval: true })} />);
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByRole("button", { name: /计划审批/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("closes the drawer from the header", () => {
    const onClose = vi.fn();
    renderPanel(<LibraryPanel {...props({ onClose })} />);

    fireEvent.click(screen.getByLabelText("关闭策略库"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists the fixed stages", () => {
    renderPanel(<LibraryPanel {...props()} />);

    expect(screen.getByText("角色阶段")).toBeTruthy();
    expect(screen.getByText("执行池")).toBeTruthy();
    expect(screen.getByText("质量门禁")).toBeTruthy();
    expect(screen.getByText("发布边界")).toBeTruthy();
  });
});
