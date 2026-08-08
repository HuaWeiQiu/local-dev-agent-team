import { describe, expect, it } from "vitest";
import { buildTaskGraph } from "../web/src/graph.js";
import { runStatusLabel, statusTone } from "../web/src/presentation.js";
import type { TaskRunState } from "../web/src/types.js";

describe("web workbench projections", () => {
  it("lays a task DAG into dependency ranks", () => {
    const tasks = [fixtureTask("api", []), fixtureTask("ui", ["api"]), fixtureTask("docs", ["api"])];
    const graph = buildTaskGraph(tasks);
    const api = graph.nodes.find((node) => node.id === "api")!;
    const ui = graph.nodes.find((node) => node.id === "ui")!;
    const docs = graph.nodes.find((node) => node.id === "docs")!;

    expect(ui.position.x).toBeGreaterThan(api.position.x);
    expect(docs.position.x).toBe(ui.position.x);
    expect(docs.position.y).not.toBe(ui.position.y);
    expect(graph.edges).toHaveLength(2);
  });

  it("maps execution states to stable labels and semantic tones", () => {
    expect(runStatusLabel("reviewing-testing")).toBe("审查测试");
    expect(statusTone("blocked")).toBe("danger");
    expect(statusTone("merged")).toBe("success");
  });
});

function fixtureTask(id: string, dependsOn: string[]): TaskRunState {
  return {
    task: {
      id,
      title: id,
      description: id,
      dependsOn,
      ownedPaths: [`src/${id}.ts`],
      acceptanceCommands: [],
      profile: null,
    },
    status: "pending",
    attempts: 0,
  };
}
