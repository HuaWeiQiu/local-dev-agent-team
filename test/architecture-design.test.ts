import { describe, expect, it } from "vitest";
import { designIssues, resolveDesign } from "../src/domain/architecture-design.js";
import type { Task, TaskPlan } from "../src/domain/contracts.js";

function task(id: string, ownedPaths: string[], dependsOn: string[] = [], elementId?: string): Task {
  return {
    id,
    title: id,
    description: id,
    dependsOn,
    ownedPaths,
    acceptanceCommands: [],
    profile: null,
    ...(elementId ? { elementId } : {}),
  };
}

function plan(tasks: Task[], design?: TaskPlan["design"]): TaskPlan {
  return { summary: "计划", tasks, ...(design ? { design } : {}) };
}

const design: NonNullable<TaskPlan["design"]> = {
  summary: "核心被测试依赖",
  source: "architect",
  elements: [
    { id: "core", name: "核心", kind: "module", responsibility: "实现功能", paths: ["src/core"] },
    { id: "tests", name: "测试", kind: "module", responsibility: "锁住行为", paths: ["test"] },
  ],
  relations: [{ from: "core", to: "tests", kind: "depends" }],
  sequence: [{ order: 1, from: "core", to: "tests", action: "把结果交给测试" }],
};

describe("architecture design", () => {
  it("rejects a plan that has tasks but no design", () => {
    expect(designIssues(plan([task("write", ["src/core/a.ts"])]))).toEqual([
      "Architecture design is missing. Return design.elements, relations and sequence, and set each task.elementId.",
    ]);
  });

  it("rejects a task whose paths sit outside its element", () => {
    const issues = designIssues(
      plan([task("write", ["src/other/a.ts"], [], "core"), task("check", ["test/a.test.ts"], ["write"], "tests")], design),
    );
    expect(issues.some((issue) => issue.includes("outside element"))).toBe(true);
  });

  it("rejects a cross-element dependency that has no depends or calls relation", () => {
    const broken = { ...design, relations: [] };
    const issues = designIssues(
      plan([task("write", ["src/core/a.ts"], [], "core"), task("check", ["test/a.test.ts"], ["write"], "tests")], broken),
    );
    expect(issues.some((issue) => issue.includes("no depends/calls relation"))).toBe(true);
  });

  it("keeps a consistent architect design and fills a missing element id", () => {
    const resolved = resolveDesign(
      plan([task("write", ["src/core/a.ts"]), task("check", ["test/a.test.ts"], ["write"])], design),
      "inferred",
    );
    expect(resolved.design?.source).toBe("architect");
    expect(resolved.tasks.map((item) => item.elementId)).toEqual(["core", "tests"]);
  });

  it("synthesizes an inferred design when the architect model does not match the tasks", () => {
    const resolved = resolveDesign(plan([task("write", ["src/core/a.ts"])]), "inferred");
    expect(resolved.design?.source).toBe("inferred");
    expect(resolved.design?.elements.map((element) => element.id)).toEqual(["src-core"]);
    expect(designIssues(resolved)).toEqual([]);
  });
});
