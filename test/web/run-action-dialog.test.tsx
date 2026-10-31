// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunActionDialog } from "../../web/src/components/RunActionDialog.js";
import type { ApprovalRequest, Task } from "../../web/src/types.js";
import { runState } from "../support/web-fixtures.js";

const task = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}`,
  dependsOn: [],
  ownedPaths: [`${id}.txt`],
  acceptanceCommands: [],
  profile: null,
});

const approval: ApprovalRequest = {
  id: "approval-1",
  gate: "plan",
  status: "pending",
  summary: "Review the plan",
  checkpointId: "c1",
  requestedAt: "2026-10-03T10:00:00.000Z",
  expiresAt: "2026-10-04T10:00:00.000Z",
};

function open(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const run = runState({
    status: "awaiting-human",
    plan: { summary: "Original", tasks: [task("T1"), task("T2")] },
    tasks: [],
  });
  render(<RunActionDialog mode="approval" approval={approval} run={run} busy={false} onClose={() => undefined} onSubmit={onSubmit} />);
  return onSubmit;
}

async function fillAudit() {
  await userEvent.type(screen.getByLabelText("操作者"), "lead");
  await userEvent.type(screen.getByLabelText("理由"), "Looks right");
}

describe("RunActionDialog plan editing", () => {
  it("submits an unchanged plan without a plan payload", async () => {
    const onSubmit = open();
    await fillAudit();
    await userEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(onSubmit).toHaveBeenCalledWith({ decision: "approved", actor: "lead", reason: "Looks right" });
  });

  it("approves with edits and sends the modified plan", async () => {
    const onSubmit = open();
    await userEvent.click(screen.getByRole("button", { name: "编辑计划后批准" }));
    await userEvent.type(screen.getByLabelText("标题", { selector: "#plan-title-T1" }), " v2");
    await userEvent.click(screen.getAllByRole("button", { name: "删除任务" })[1]!);
    await fillAudit();
    await userEvent.click(screen.getByRole("button", { name: "批准修改后的计划" }));
    const call = onSubmit.mock.calls[0]![0] as { plan: { tasks: Task[] } };
    expect(call.plan.tasks.map((item) => [item.id, item.title])).toEqual([["T1", "Task T1 v2"]]);
  });

  it("blocks approval while the draft is invalid", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "编辑计划后批准" }));
    await userEvent.clear(screen.getByLabelText("标题", { selector: "#plan-title-T1" }));
    await fillAudit();
    expect(screen.getByRole("alert")).toHaveTextContent("缺少标题");
    expect(screen.getByRole("button", { name: "批准修改后的计划" })).toBeDisabled();
  });
});
