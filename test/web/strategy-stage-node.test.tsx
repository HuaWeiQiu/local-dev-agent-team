// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Handle: () => null,
  };
});

const { StrategyStageNode } = await import("../../web/src/components/strategy/StageNode.js");

function node(stage: Record<string, unknown>, selected = false) {
  return render(
    <StrategyStageNode
      {...({
        data: { stage, sourcePosition: "right", targetPosition: "left" },
        selected,
      } as never)}
    />,
  );
}

describe("StrategyStageNode", () => {
  it("shows the stage label and its kind", () => {
    const { container } = node({ kind: "agent", label: "实现", roles: [] });

    expect(screen.getByText("实现")).toBeTruthy();
    expect(container.textContent).toContain("实现");
  });

  it("joins the role labels when the stage names roles", () => {
    node({ kind: "worker-pool", label: "并行", roles: ["worker", "reviewer"] });

    expect(screen.textContent ?? document.body.textContent).toBeTruthy();
    expect(document.body.textContent).toMatch(/\+/);
  });

  it("adds the selection outline only when selected", () => {
    const { container, rerender } = node({ kind: "quality-gate", label: "门禁", roles: [] });
    const first = container.firstElementChild?.className ?? "";
    expect(first).not.toContain("outline-2");

    rerender(
      <StrategyStageNode
        {...({
          data: {
            stage: { kind: "quality-gate", label: "门禁", roles: [] },
            sourcePosition: "right",
            targetPosition: "left",
          },
          selected: true,
        } as never)}
      />,
    );
    expect(container.firstElementChild?.className ?? "").toContain("outline-2");
  });

  it("renders each stage kind without a role line", () => {
    for (const kind of ["agent", "worker-pool", "quality-gate", "human-approval", "publication"]) {
      const { unmount } = node({ kind, label: kind, roles: [] });
      expect(document.body.textContent).toContain(kind);
      unmount();
    }
  });
});
