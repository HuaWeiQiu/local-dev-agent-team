import { describe, expect, it } from "vitest";
import { buildArchitectureDiagram, moduleKey, presentArchitecture } from "../../web/src/architecture.js";
import type { ArchitectureDesign } from "../../web/src/types.js";
import type { Task, TaskRunState } from "../../web/src/types.js";

function task(id: string, dependsOn: string[], path: string, status: TaskRunState["status"] = "pending"): TaskRunState {
  const source: Task = {
    id,
    title: id,
    description: id,
    dependsOn,
    ownedPaths: [path],
    acceptanceCommands: [],
    profile: null,
  };
  return { task: source, status, attempts: 0 };
}

describe("architecture diagram", () => {
  it("groups files into modules and draws an arrow only across modules", () => {
    expect(moduleKey("src/cart/coupon.ts")).toBe("src/cart");
    expect(moduleKey("docs/checkout.md")).toBe("docs");
    const diagram = buildArchitectureDiagram([
      task("coupon", [], "src/cart/coupon.ts", "merged"),
      task("summary", ["coupon"], "src/cart/CartSummary.tsx", "working"),
      task("docs", ["summary"], "docs/checkout.md"),
    ]);
    expect(diagram.boxes.map((box) => box.id).sort()).toEqual(["docs", "src/cart"]);
    expect(diagram.edges).toEqual([{ from: "src/cart", to: "docs" }]);
    expect(diagram.boxes.find((box) => box.id === "src/cart")?.status).toBe("working");
    const docs = diagram.boxes.find((box) => box.id === "docs");
    const cart = diagram.boxes.find((box) => box.id === "src/cart");
    expect(docs && cart && docs.y).toBeGreaterThan(cart.y);
  });

  it("returns an empty diagram before the architect has split any tasks", () => {
    expect(buildArchitectureDiagram([])).toMatchObject({ boxes: [], edges: [] });
  });

  it("draws the stored design and labels a missing design as inferred", () => {
    const tasks = [
      task("schema", [], "src/export/schema.ts"),
      task("api", ["schema"], "src/api/export.ts"),
    ];
    tasks[0]!.task.elementId = "export";
    tasks[1]!.task.elementId = "api";
    const design: ArchitectureDesign = {
      summary: "接口调用导出核心",
      source: "architect",
      elements: [
        { id: "export", name: "导出核心", kind: "module", responsibility: "生成 CSV", paths: ["src/export"] },
        { id: "api", name: "导出接口", kind: "interface", responsibility: "提供下载", paths: ["src/api"] },
      ],
      relations: [{ from: "export", to: "api", kind: "calls", label: "接口取 CSV" }],
      sequence: [{ order: 1, from: "api", to: "export", action: "生成 CSV" }],
    };
    const presented = presentArchitecture(tasks, design);
    expect(presented.source).toBe("architect");
    expect(presented.diagram.boxes.map((box) => box.label).sort()).toEqual(["导出接口", "导出核心"]);
    expect(presented.diagram.edges).toEqual([{ from: "export", to: "api", kind: "calls", label: "接口取 CSV" }]);
    expect(presentArchitecture(tasks).source).toBe("inferred");
  });
});
