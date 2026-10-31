// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StageStepper } from "../../web/src/components/StageStepper.js";
import type { StageId } from "../../web/src/stages.js";
import { runState } from "../support/web-fixtures.js";

describe("StageStepper", () => {
  it("marks the current stage and reports the visited ones", () => {
    const run = runState({
      status: "implementing",
      history: [
        { at: "2026-08-11T18:00:00.000Z", status: "created", message: "运行已创建" },
        { at: "2026-08-11T18:01:00.000Z", status: "planning", message: "开始规划" },
      ],
    });
    render(<StageStepper run={run} />);

    const steps = screen.getAllByRole("button");
    expect(steps.length).toBeGreaterThan(1);
    const current = document.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
  });

  it("reports the clicked stage and highlights the controlled selection", async () => {
    const onSelectStage = vi.fn<(id: StageId) => void>();
    const run = runState({ status: "implementing" });
    const { rerender } = render(<StageStepper run={run} onSelectStage={onSelectStage} />);

    const target = screen.getAllByRole("button")[0]!;
    await userEvent.click(target);
    expect(onSelectStage).toHaveBeenCalledTimes(1);

    const selected = onSelectStage.mock.calls[0]![0];
    rerender(
      <StageStepper run={run} selectedStageId={selected} onSelectStage={onSelectStage} />,
    );
    const pressed = screen
      .getAllByRole("button")
      .filter((step) => step.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
  });

  it("keeps every rendered step reachable when no handler is given", () => {
    const run = runState({ status: "cancelled" });
    render(<StageStepper run={run} />);
    for (const step of screen.getAllByRole("button")) {
      expect(step.getAttribute("aria-pressed")).toBe("false");
    }
  });
});
