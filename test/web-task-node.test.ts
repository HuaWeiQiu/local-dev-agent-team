import { describe, expect, it } from "vitest";
import { dependencyLabel, taskNodeView } from "../web/src/components/run/task-node/model.js";
import type { TaskNodeData } from "../web/src/graph.js";

function data(patch: Record<string, unknown> = {}): TaskNodeData {
  return {
    task: {
      task: {
        id: "T1",
        title: "实现导出",
        description: "实现导出模块",
        dependsOn: [],
        ownedPaths: ["src/a.ts"],
        acceptanceCommands: [{ command: "pnpm", args: ["test"] }],
        profile: null,
      },
      status: "merged",
      attempts: 1,
    },
    runStatus: "implementing",
    ...patch,
  } as unknown as TaskNodeData;
}

describe("dependencyLabel", () => {
  it("names the dependencies, or says there are none", () => {
    expect(dependencyLabel([])).toBe("无依赖");
    expect(dependencyLabel(["T1", "T2"])).toBe("depends: T1, T2");
  });
});

describe("taskNodeView", () => {
  it("carries the task's identity and wording", () => {
    const view = taskNodeView(data());
    expect(view).toMatchObject({ id: "T1", title: "实现导出", status: "merged" });
    expect(view.kind).toBeTruthy();
    expect(view.dependency).toBe("无依赖");
  });

  it("picks a tone bar for the status", () => {
    expect(taskNodeView(data()).toneBar).toMatch(/^bg-/);
    expect(
      taskNodeView(data({ task: { ...data().task, status: "failed" } })).toneBar,
    ).toMatch(/^bg-/);
  });

  it("defaults the run status when the node does not carry one", () => {
    const view = taskNodeView({ ...data(), runStatus: undefined } as never);
    expect(view).toBeTruthy();
  });

  it("reports the compact layout only when asked", () => {
    expect(taskNodeView(data()).compact).toBe(false);
    expect(taskNodeView(data({ compactLayout: true })).compact).toBe(true);
    expect(taskNodeView(data({ compactLayout: "yes" })).compact).toBe(false);
  });

  it("lists the dependencies when there are some", () => {
    const withDeps = data();
    withDeps.task.task.dependsOn = ["T0"] as never;
    expect(taskNodeView(withDeps).dependency).toBe("depends: T0");
  });
});
