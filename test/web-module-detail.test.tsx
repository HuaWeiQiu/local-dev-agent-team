// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModuleDetail } from "../web/src/components/architecture/ModuleDetail.js";
import {
  incomingEdges,
  kindPrefix,
  labelOf,
  moduleById,
  outgoingEdges,
  pathRows,
  relationSuffix,
  responsibilityOf,
} from "../web/src/components/architecture/module/model.js";
import { presentArchitecture } from "../web/src/architecture.js";
import type { ArchitectureDesign, TaskRunState } from "../web/src/types.js";

function task(id: string, patch: Record<string, unknown> = {}): TaskRunState {
  return {
    task: { id, title: `任务 ${id}`, description: "", dependsOn: [], ownedPaths: [`src/${id}/x.ts`], acceptanceCommands: [], elementId: "cart" },
    status: "working",
    attempts: 1,
    ...patch,
  } as unknown as TaskRunState;
}

function design(): ArchitectureDesign {
  return {
    source: "architect",
    summary: "设计",
    elements: [
      { id: "cart", name: "购物车", kind: "module", responsibility: "算钱", paths: ["src/cart"] },
      { id: "order", name: "订单", kind: "module", responsibility: "下单", paths: ["src/order"] },
      { id: "docs", name: "文档", kind: "data", responsibility: "说明", paths: ["docs"] },
    ],
    relations: [
      { from: "order", to: "cart", kind: "calls", label: "调用" },
      { from: "cart", to: "docs", kind: "depends" },
    ],
    sequence: [],
  } as unknown as ArchitectureDesign;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    tasks: [task("T1")],
    design: design(),
    moduleId: "cart",
    onSelectTask: vi.fn(),
    onSelectModule: vi.fn(),
    ...patch,
  } as never;
}

describe("module detail model", () => {
  const diagram = presentArchitecture([task("T1")], design()).diagram;

  it("finds modules and labels them", () => {
    expect(moduleById(diagram, "cart")?.label).toBe("购物车");
    expect(moduleById(diagram, "ghost")).toBeUndefined();
    expect(labelOf(diagram, "cart")).toBe("购物车");
    expect(labelOf(diagram, "ghost")).toBe("ghost");
  });

  it("splits incoming and outgoing edges", () => {
    expect(incomingEdges(diagram, "cart").map((edge) => edge.from)).toEqual(["order"]);
    expect(outgoingEdges(diagram, "cart").map((edge) => edge.to)).toEqual(["docs"]);
  });

  it("formats the kind prefix and relation suffix", () => {
    expect(kindPrefix("module")).toContain("模块");
    expect(kindPrefix(undefined)).toBe("");
    expect(relationSuffix("calls")).toContain("调用");
    expect(relationSuffix(undefined)).toBe("");
  });

  it("falls back to the inferred-responsibility sentence", () => {
    expect(responsibilityOf({ responsibility: "算钱" })).toBe("算钱");
    expect(responsibilityOf({})).toContain("推断");
  });

  it("lists the index path before the declared paths", () => {
    expect(pathRows({ paths: ["src/cart"] }, "/repo/src/cart")).toEqual([
      { label: "索引", value: "/repo/src/cart" },
      { label: "路径", value: "src/cart" },
    ]);
    expect(pathRows({ paths: [] }, undefined)).toEqual([]);
  });
});

describe("ModuleDetail", () => {
  it("renders nothing for an unknown module", () => {
    const { container } = render(<ModuleDetail {...(props({ moduleId: "ghost" }) as object)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the header, paths, relations and tasks", () => {
    render(<ModuleDetail {...(props() as object)} />);
    expect(screen.getByText("购物车")).toBeVisible();
    expect(screen.getByText("算钱")).toBeVisible();
    expect(screen.getByText("负责路径")).toBeVisible();
    // Without a repository trace only the declared paths are listed.
    expect(screen.getByText("src/cart")).toBeVisible();
    expect(screen.getByText("上下游")).toBeVisible();
    expect(screen.getByText(/上游 订单/)).toBeVisible();
    expect(screen.getByRole("button", { name: /任务 T1/ })).toBeTruthy();
  });

  it("navigates to a related module and back", async () => {
    const onSelectModule = vi.fn();
    const onClearModule = vi.fn();
    render(<ModuleDetail {...(props({ onSelectModule, onClearModule }) as object)} />);
    await userEvent.click(screen.getByText(/上游 订单/));
    expect(onSelectModule).toHaveBeenCalledWith("order");
    await userEvent.click(screen.getByRole("button", { name: "返回整个系统" }));
    expect(onClearModule).toHaveBeenCalled();
  });

  it("selects a task from the module", async () => {
    const onSelectTask = vi.fn();
    render(<ModuleDetail {...(props({ onSelectTask }) as object)} />);
    await userEvent.click(screen.getByRole("button", { name: /任务 T1/ }));
    expect(onSelectTask).toHaveBeenCalled();
  });
});
