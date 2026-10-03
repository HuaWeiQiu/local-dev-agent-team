// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunLiveBar } from "../../web/src/components/RunLiveBar.js";
import type { LiveStatus } from "../../web/src/live-status.js";

const base: LiveStatus = {
  statusLabel: "执行中",
  running: true,
  startedAt: new Date().toISOString(),
  workers: [{ id: "a", label: "工人 · codex-worker", advisor: false }],
  hiddenWorkers: 2,
  tasksDone: 1,
  tasksTotal: 4,
  pendingApprovals: 0,
  invocations: { used: 5, max: 64 },
  advisor: { used: 1, max: 3 },
};

describe("RunLiveBar", () => {
  it("summarizes running workers and budgets", async () => {
    const onOpenActivity = vi.fn();
    render(<RunLiveBar status={base} onOpenActivity={onOpenActivity} />);
    expect(screen.getByRole("status")).toHaveTextContent("执行中");
    expect(screen.getByText("工人 · codex-worker")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("任务 1/4")).toBeInTheDocument();
    expect(screen.getByText("调用 5/64")).toBeInTheDocument();
    expect(screen.getByText("顾问 1/3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "查看活动" }));
    expect(onOpenActivity).toHaveBeenCalled();
  });

  it("renders nothing for an idle run without pending approvals", () => {
    const { container } = render(
      <RunLiveBar status={{ ...base, running: false, workers: [] }} onOpenActivity={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("stays visible with an attention pill while waiting on approval", () => {
    render(<RunLiveBar status={{ ...base, running: false, pendingApprovals: 2 }} onOpenActivity={() => undefined} />);
    expect(screen.getByText("2 项待审批")).toBeInTheDocument();
    expect(screen.queryByText("等待角色启动")).not.toBeInTheDocument();
  });
});
