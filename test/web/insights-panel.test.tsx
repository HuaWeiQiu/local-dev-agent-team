// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunInsights } from "../../web/src/hooks/useRunInsights.js";
import type { ReplayStep } from "../../web/src/types.js";
import { InsightsPanel } from "../../web/src/components/InsightsPanel.js";

function insights(patch: Partial<RunInsights> = {}): RunInsights {
  return {
    explanation: undefined,
    usage: undefined,
    replay: undefined,
    transcripts: undefined,
    loading: false,
    error: undefined,
    loadTranscript: vi.fn(),
    loadDiff: vi.fn(),
    ...patch,
  } as RunInsights;
}

function step(): ReplayStep {
  return {
    at: "2026-11-02T00:00:00.000Z",
    offsetMs: 1_500,
    kind: "status",
    tone: "neutral",
    title: "实现 build",
  };
}

describe("InsightsPanel", () => {
  it("starts on the why tab and says there is nothing yet", () => {
    render(<InsightsPanel insights={insights()} />);

    expect(screen.getByLabelText("洞察视图")).toBeTruthy();
    expect(screen.getByText("暂无数据")).toBeTruthy();
  });

  it("says it is summarising while the run is still loading", () => {
    render(<InsightsPanel insights={insights({ loading: true })} />);

    expect(screen.getByText("正在汇总…")).toBeTruthy();
  });

  it("shows the error the insights could not hide", () => {
    render(<InsightsPanel insights={insights({ error: "读取失败" })} />);

    expect(screen.getByRole("alert").textContent).toBe("读取失败");
  });

  it("switches the body with the tab", () => {
    render(<InsightsPanel insights={insights({ replay: [step()] })} />);

    const replayTab = screen.getAllByText("回放").at(-1)!;
    fireEvent.mouseDown(replayTab);
    fireEvent.click(replayTab);

    expect(screen.getByLabelText("回放步骤")).toBeTruthy();
  });
});
