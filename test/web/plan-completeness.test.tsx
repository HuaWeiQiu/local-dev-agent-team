// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlanCompletenessReport } from "../../web/src/plan-completeness.js";
import { PlanCompleteness } from "../../web/src/components/run/PlanCompleteness.js";

function report(patch: Partial<PlanCompletenessReport> = {}): PlanCompletenessReport {
  return {
    status: "complete",
    namedDeliverables: [],
    coveredDeliverables: [],
    issues: [],
    ...patch,
  } as PlanCompletenessReport;
}

describe("PlanCompleteness", () => {
  it("starts collapsed when the plan is complete", () => {
    const { container } = render(
      <PlanCompleteness
        report={report()}
        tone="success"
        title="计划覆盖"
        taskCount={3}
      />,
    );

    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("3 条任务")).toBeTruthy();
  });

  it("starts open whenever the plan is not complete", () => {
    const { container } = render(
      <PlanCompleteness
        report={report({ status: "partial" })}
        tone="warning"
        title="计划覆盖"
        taskCount={2}
      />,
    );

    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("counts covered deliverables when the plan names any", () => {
    render(
      <PlanCompleteness
        report={report({
          namedDeliverables: ["T1", "T2", "T3"],
          coveredDeliverables: ["T1", "T2"],
        })}
        tone="warning"
        title="计划覆盖"
        taskCount={3}
      />,
    );

    expect(screen.getByText("覆盖 2/3")).toBeTruthy();
  });

  it("lists the issues it found", () => {
    render(
      <PlanCompleteness
        report={report({ issues: ["T2 没有任务承接", "未覆盖 T3"] })}
        tone="danger"
        title="计划覆盖"
        taskCount={2}
      />,
    );

    expect(screen.getByText("T2 没有任务承接")).toBeTruthy();
    expect(screen.getByText("未覆盖 T3")).toBeTruthy();
  });

  it("says so when there is nothing to report", () => {
    render(
      <PlanCompleteness report={report()} tone="success" title="计划覆盖" taskCount={1} />,
    );

    expect(screen.getByText("目标编号已覆盖，无只读独苗。")).toBeTruthy();
  });
});
