// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationFooter } from "../../web/src/components/evolution/automation/sections.js";
import type { AutomaticEvolutionSnapshot } from "../../web/src/types.js";

/**
 * `AutomationNote` picks one of two branches on `isError`, and those six lines flipped
 * between two runs of the same suite: they were only reached through whichever consumer
 * happened to render an error before the test ended. Rendering `AutomationFooter` with
 * the branch chosen explicitly makes the coverage a property of the assertion.
 */
function snapshot(patch: Partial<AutomaticEvolutionSnapshot> = {}): AutomaticEvolutionSnapshot {
  return {
    enabled: true,
    autoStart: false,
    status: "running",
    phase: "evaluating",
    configuredMaxCycles: 3,
    requestedMaxCycles: null,
    completedCycles: 1,
    maxConsecutiveNoImprovement: 2,
    consecutiveNoImprovement: 0,
    evaluationRepeats: 1,
    minimumScoreDelta: 0.5,
    baselineStrategy: null,
    targetStrategy: "balanced",
    sessionId: "session-1",
    activeRunId: null,
    incumbentScore: null,
    incumbentStrategy: null,
    stopReason: null,
    error: null,
    failureCode: null,
    roleBindingSource: null,
    startedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastEvaluation: null,
    cycles: [],
    ...patch,
  } as AutomaticEvolutionSnapshot;
}

const noop = () => undefined;

describe("AutomationFooter note", () => {
  it("renders the error callout with the failure code", () => {
    render(
      <AutomationFooter
        automation={snapshot({ failureCode: "EVAL_FAILED" })}
        note="评估失败"
        isError
        open={false}
        onToggle={noop}
      />,
    );
    expect(screen.getByText("[EVAL_FAILED]")).toBeVisible();
    expect(screen.getByText("评估失败")).toBeVisible();
  });

  it("renders the plain note without a failure code", () => {
    render(
      <AutomationFooter automation={snapshot()} note="正在评估" isError={false} open={false} onToggle={noop} />,
    );
    expect(screen.getByText("正在评估")).toBeVisible();
    expect(screen.queryByText(/\[EVAL_FAILED\]/)).toBeNull();
  });

  it("keeps the failure code in the non-error note too", () => {
    render(
      <AutomationFooter
        automation={snapshot({ failureCode: "RETRY_LATER" })}
        note="稍后重试"
        isError={false}
        open={false}
        onToggle={noop}
      />,
    );
    expect(screen.getByText(/\[RETRY_LATER\]/)).toBeVisible();
  });
});
