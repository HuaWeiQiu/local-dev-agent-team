// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReplayStep } from "../../web/src/types.js";
import { ReplayView } from "../../web/src/components/insights/ReplayView.js";

function step(patch: Partial<ReplayStep> = {}): ReplayStep {
  return {
    at: "2026-11-02T00:00:00.000Z",
    offsetMs: 1_500,
    kind: "status",
    tone: "neutral",
    title: "实现 build",
    ...patch,
  };
}

describe("ReplayView", () => {
  it("explains an empty replay", () => {
    render(<ReplayView steps={[]} />);

    expect(screen.getByText("还没有可回放的过程")).toBeTruthy();
  });

  it("lists every step and marks the current one", () => {
    render(
      <ReplayView
        steps={[
          step({ title: "第一步", nodeId: "build" }),
          step({ title: "第二步", taskId: "T1", detail: "细节", offsetMs: 3_000 }),
        ]}
      />,
    );

    expect(screen.getByText("第一步")).toBeTruthy();
    expect(screen.getByText("T1")).toBeTruthy();
    expect(screen.getByText("细节")).toBeTruthy();
    expect(screen.getByLabelText("阶段状态").textContent).toContain("build · 第一步");
  });

  it("rewinds to the start when play is pressed at the end", () => {
    const { container } = render(
      <ReplayView steps={[step({ title: "一" }), step({ title: "二" })]} />,
    );

    fireEvent.click(screen.getByLabelText("开始回放"));

    expect(screen.getByLabelText("暂停回放")).toBeTruthy();
    expect(container.querySelector("input[type=range]")).toHaveProperty("value", "0");
  });

  it("stops playing when the operator seeks", () => {
    const { container } = render(
      <ReplayView steps={[step({ title: "一" }), step({ title: "二" })]} />,
    );
    fireEvent.click(screen.getByLabelText("开始回放"));

    fireEvent.change(container.querySelector("input[type=range]")!, { target: { value: "1" } });

    expect(screen.getByLabelText("开始回放")).toBeTruthy();
  });
});
