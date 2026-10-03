import { describe, expect, it } from "vitest";
import { buildArchitectureDiagram, describeStage, moduleKey, presentArchitecture } from "../../web/src/architecture.js";
import type { ArchitectureDesign, RunEvent, RunState } from "../../web/src/types.js";
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

  it("snapshots one stage: its input, extra attempts, and only that step's events", () => {
    const working = task("csv", [], "src/export/csv.ts", "working");
    working.attempts = 3;
    const run = {
      goal: "导出",
      status: "implementing",
      history: [{ at: "2026-01-01T00:00:00.000Z", status: "implementing", message: "开始实现" }],
      tasks: [working],
    } as RunState;
    const events: RunEvent[] = [
      {
        sequence: 1,
        id: "e1",
        schemaVersion: 1,
        runId: "r",
        type: "agent.stdout",
        occurredAt: "2026-01-01T00:01:00.000Z",
        payload: { role: "worker", invocationId: "w", text: "写入 csv" },
        traceId: "t",
        spanId: "s",
      },
      {
        sequence: 2,
        id: "e2",
        schemaVersion: 1,
        runId: "r",
        type: "agent.stdout",
        occurredAt: "2026-01-01T00:02:00.000Z",
        payload: { role: "architect", invocationId: "a", text: "这是规划，不属于实现" },
        traceId: "t",
        spanId: "s2",
      },
    ];
    const brief = describeStage(run, "build", events);
    expect(brief.input).toBe("csv");
    expect(brief.retries).toBe(2);
    expect(brief.ledger.map((entry) => entry.detail)).toEqual(["写入 csv"]);
  });
});
