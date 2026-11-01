import { describe, expect, it } from "vitest";
import { designIssues, resolveDesign, synthesizeDesign } from "../src/domain/architecture-design.js";
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

describe("architecture design issues", () => {
  it("reports a duplicated element id", () => {
    const duplicated = {
      ...design,
      elements: [design.elements[0]!, { ...design.elements[0]! }, design.elements[1]!],
    };
    expect(designIssues(plan([task("write", ["src/core/a.ts"], [], "core")], duplicated))).toEqual([
      "Duplicate architecture element 'core'",
    ]);
  });

  it("reports a relation that names an element the design does not have", () => {
    const broken = { ...design, relations: [{ from: "core", to: "ghost", kind: "reads" as const }] };
    expect(designIssues(plan([task("write", ["src/core/a.ts"], [], "core")], broken))).toEqual([
      "Relation core -> ghost names an unknown element",
    ]);
  });

  it("reports an element that relates to itself", () => {
    const broken = { ...design, relations: [{ from: "core", to: "core", kind: "calls" as const }] };
    expect(designIssues(plan([task("write", ["src/core/a.ts"], [], "core")], broken))).toEqual([
      "Element 'core' cannot relate to itself",
    ]);
  });

  it("reports a sequence step that names an element the design does not have", () => {
    const broken = { ...design, sequence: [{ order: 3, from: "core", to: "ghost", action: "交接" }] };
    expect(designIssues(plan([task("write", ["src/core/a.ts"], [], "core")], broken))).toEqual([
      "Sequence step 3 names an unknown element",
    ]);
  });

  it("reports a task that no single element covers", () => {
    expect(designIssues(plan([task("write", ["docs/guide.md"])], design))).toEqual([
      "Task 'write' is not covered by exactly one architecture element",
    ]);
  });

  it("accepts a calls relation between the elements of two dependent tasks", () => {
    const calls = { ...design, relations: [{ from: "core", to: "tests", kind: "calls" as const }] };
    const covered = plan([task("write", ["src/core/a.ts"]), task("check", ["test/a.test.ts"], ["write"])], calls);
    expect(designIssues(covered)).toEqual([]);
  });

  it("ignores a dependency on a task the plan does not contain, and one inside the same element", () => {
    const tasks = [
      task("write", ["src/core/a.ts"], ["ghost", "helper"]),
      task("helper", ["src/core/b.ts"]),
    ];
    expect(designIssues(plan(tasks, design))).toEqual([]);
  });

  it("ignores an element id that the design does not define when the paths still match", () => {
    expect(designIssues(plan([task("write", ["src/core/a.ts"], [], "ghost")], design))).toEqual([]);
  });
});

describe("synthesized design", () => {
  it("groups tasks by module, keeps path order and joins the responsibilities", () => {
    const inferred = synthesizeDesign(
      plan([
        task("write", ["src/domain/a.ts", "src/domain/b.ts"]),
        task("done", ["docs/guide.md"]),
        task("more", ["src/domain/c.ts"]),
      ]),
      "controller",
    );
    expect(inferred.design?.source).toBe("controller");
    expect(inferred.design?.elements).toEqual([
      {
        id: "src-domain",
        name: "src-domain",
        kind: "module",
        responsibility: "write；more",
        paths: ["src/domain/a.ts", "src/domain/b.ts", "src/domain/c.ts"],
      },
      {
        id: "docs",
        name: "docs",
        kind: "module",
        responsibility: "done",
        paths: ["docs/guide.md"],
      },
    ]);
    expect(inferred.tasks.map((item) => item.elementId)).toEqual(["src-domain", "docs", "src-domain"]);
  });

  it("collapses a wildcard path to its static module and falls back to the task id", () => {
    const inferred = synthesizeDesign(
      plan([task("globs", ["src/**/*.ts"]), task("loose", [])]),
      "inferred",
    );
    expect(inferred.design?.elements.map((element) => element.id)).toEqual(["src", "loose"]);
  });

  it("records one depends relation and one sequence step per element pair", () => {
    const inferred = synthesizeDesign(
      plan([
        task("write", ["src/core/a.ts"]),
        task("check", ["test/a.test.ts"], ["write"]),
        task("more", ["test/b.test.ts"], ["write"]),
      ]),
      "inferred",
    );
    expect(inferred.design?.relations).toEqual([{ from: "src-core", to: "test", kind: "depends" }]);
    expect(inferred.design?.sequence).toEqual([
      { order: 1, from: "src-core", to: "test", action: "交接" },
    ]);
  });
});
