// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { TaskNode } from "../web/src/components/run/TaskNode.js";
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

function node(nodeData: TaskNodeData, selected = false) {
  return render(
    <ReactFlowProvider>
      <TaskNode
        {...({ data: nodeData, selected, id: "T1", type: "task", dragging: false, zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 } as never)}
      />
    </ReactFlowProvider>,
  );
}

describe("TaskNode", () => {
  it("renders the task identity, kind and dependency", () => {
    const { container } = node(data());
    expect(screen.getByText("T1")).toBeTruthy();
    expect(screen.getByText("实现导出")).toBeTruthy();
    expect(screen.getByText("无依赖")).toBeTruthy();
    expect(container.querySelectorAll(".react-flow__handle").length).toBe(2);
  });

  it("marks a selected node", () => {
    const { container } = node(data(), true);
    expect(container.innerHTML).toContain("outline-accent");
  });

  it("moves its handles in the compact layout", () => {
    const { container } = node(data({ compactLayout: true }));
    expect(container.querySelectorAll(".react-flow__handle-top, .react-flow__handle-bottom").length).toBe(2);
  });
});
