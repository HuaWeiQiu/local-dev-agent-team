import { describe, expect, it } from "vitest";
import { singleTaskPlan } from "../src/flow/single-task.js";

describe("singleTaskPlan", () => {
  it("turns the whole goal into one task that may touch any path", () => {
    const plan = singleTaskPlan("Add a --verbose flag to the CLI");

    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      id: "T1",
      title: "Add a --verbose flag to the CLI",
      description: "Add a --verbose flag to the CLI",
      ownedPaths: ["**"],
      evidenceKind: "commands",
    });
  });

  it("uses the first line as the title and keeps the full goal as the description", () => {
    const plan = singleTaskPlan("First line\nsecond line");

    expect(plan.tasks[0]?.title).toBe("First line");
    expect(plan.tasks[0]?.description).toBe("First line\nsecond line");
  });

  it("truncates a long first line to the title budget", () => {
    const long = "x".repeat(100);
    const plan = singleTaskPlan(long);

    expect(plan.tasks[0]?.title).toHaveLength(80);
    expect(plan.tasks[0]?.title.endsWith("…")).toBe(true);
  });

  it("falls back to a placeholder title for an empty goal", () => {
    const plan = singleTaskPlan("   \n  ");

    expect(plan.tasks[0]?.title).toBe("Implement the goal");
    expect(plan.tasks[0]?.description).toBe("");
  });
});
