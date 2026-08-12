import { describe, expect, it } from "vitest";
import type { TaskPlan } from "../src/domain/contracts.js";
import { pathsMayOverlap, selectTaskWave, validateTaskPlan } from "../src/domain/plan.js";

function plan(): TaskPlan {
  return {
    summary: "fixture",
    tasks: [
      {
        id: "api",
        title: "API",
        description: "Implement API",
        dependsOn: [],
        ownedPaths: ["src/api/**"],
        acceptanceCommands: [],
        profile: null,
      },
      {
        id: "web",
        title: "Web",
        description: "Implement web",
        dependsOn: [],
        ownedPaths: ["src/web/**"],
        acceptanceCommands: [],
        profile: null,
      },
      {
        id: "integration",
        title: "Integration",
        description: "Join both",
        dependsOn: ["api", "web"],
        ownedPaths: ["test/integration/**"],
        acceptanceCommands: [],
        profile: null,
      },
    ],
  };
}

describe("task plans", () => {
  it("selects dependency-ready non-overlapping work", () => {
    const fixture = plan();
    validateTaskPlan(fixture);
    expect(selectTaskWave(fixture, new Set(), new Set(), 3).map((task) => task.id)).toEqual([
      "api",
      "web",
    ]);
  });

  it("detects dependency cycles", () => {
    const fixture = plan();
    fixture.tasks[0]!.dependsOn = ["integration"];
    expect(() => validateTaskPlan(fixture)).toThrow("dependency cycle");
  });

  it("conservatively detects path overlap", () => {
    expect(pathsMayOverlap(["src/**"], ["src/api/**"])).toBe(true);
    expect(pathsMayOverlap(["src/web/**"], ["src/api/**"])).toBe(false);
  });

  it("prefers packing the same batchKey before mixing other batches", () => {
    const fixture: TaskPlan = {
      summary: "batch affinity",
      tasks: [
        {
          id: "a1",
          title: "A1",
          description: "batch a",
          dependsOn: [],
          ownedPaths: ["src/a1.ts"],
          acceptanceCommands: [],
          profile: null,
          batchKey: "batch-a",
        },
        {
          id: "b1",
          title: "B1",
          description: "batch b",
          dependsOn: [],
          ownedPaths: ["src/b1.ts"],
          acceptanceCommands: [],
          profile: null,
          batchKey: "batch-b",
        },
        {
          id: "a2",
          title: "A2",
          description: "batch a",
          dependsOn: [],
          ownedPaths: ["src/a2.ts"],
          acceptanceCommands: [],
          profile: null,
          batchKey: "batch-a",
        },
      ],
    };
    validateTaskPlan(fixture);
    const wave = selectTaskWave(fixture, new Set(), new Set(), 2);
    expect(wave.map((task) => task.id)).toEqual(["a1", "a2"]);
  });
});
