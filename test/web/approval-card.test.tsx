// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../../web/src/components/ApprovalCard.js";
import type { ApprovalRequest } from "../../web/src/types.js";
import { runState } from "../support/web-fixtures.js";

const approval = (gate: "plan" | "final"): ApprovalRequest => ({
  id: "approval-1",
  gate,
  status: "pending",
  summary: "共 3 个任务，预计改动 12 个文件",
  checkpointId: "checkpoint-1",
  requestedAt: "2026-08-11T18:00:00.000Z",
  expiresAt: "2026-08-12T18:00:00.000Z",
});

describe("ApprovalCard", () => {
  it("shows the gate, summary and opens the review dialog on click", async () => {
    const onReview = vi.fn();
    render(<ApprovalCard run={runState()} approval={approval("final")} busy={false} onReview={onReview} />);
    expect(screen.getByText("交付结果等待你审批")).toBeInTheDocument();
    expect(screen.getByText("共 3 个任务，预计改动 12 个文件")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "审阅并处理" }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("uses plan wording and disables the action while busy", () => {
    render(<ApprovalCard run={runState()} approval={approval("plan")} busy onReview={() => undefined} />);
    expect(screen.getByText("执行计划等待你审批")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "审阅并处理" })).toBeDisabled();
  });
});
