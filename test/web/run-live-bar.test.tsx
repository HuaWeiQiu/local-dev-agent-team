// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LiveStatus } from "../../web/src/live-status.js";
import { RunLiveBar } from "../../web/src/components/RunLiveBar.js";

function status(patch: Partial<LiveStatus> = {}): LiveStatus {
  return {
    statusLabel: "实现中",
    running: true,
    startedAt: "2026-11-02T00:00:00.000Z",
    workers: [],
    hiddenWorkers: 0,
    tasksDone: 2,
    tasksTotal: 5,
    pendingApprovals: 0,
    invocations: { used: 3, max: 64 },
    advisor: undefined,
    ...patch,
  };
}

describe("RunLiveBar", () => {
  it("stays out of the way when the run is idle and nothing waits for approval", () => {
    const { container } = render(
      <RunLiveBar status={status({ running: false })} onOpenActivity={() => undefined} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("still shows a parked run that waits for an approval", () => {
    render(
      <RunLiveBar
        status={status({ running: false, pendingApprovals: 2 })}
        onOpenActivity={() => undefined}
      />,
    );

    expect(screen.getByText("2 项待审批")).toBeTruthy();
    expect(screen.queryByText("等待角色启动")).toBeNull();
  });

  it("says nobody started yet when the run is active without workers", () => {
    render(<RunLiveBar status={status()} onOpenActivity={() => undefined} />);

    expect(screen.getByText("等待角色启动")).toBeTruthy();
  });

  it("lists the visible workers and counts the hidden ones", () => {
    render(
      <RunLiveBar
        status={status({
          workers: [
            { id: "w1", label: "实现者 · fast", advisor: false },
            { id: "w2", label: "顾问 · deep", advisor: true },
          ],
          hiddenWorkers: 2,
        })}
        onOpenActivity={() => undefined}
      />,
    );

    expect(screen.getByText("实现者 · fast")).toBeTruthy();
    expect(screen.getByText("顾问 · deep")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("shows the advisor budget only when the strategy has one", () => {
    const { rerender } = render(
      <RunLiveBar status={status()} onOpenActivity={() => undefined} />,
    );
    expect(screen.queryByText(/顾问 0/)).toBeNull();

    rerender(
      <RunLiveBar
        status={status({ advisor: { used: 1, max: 3 } })}
        onOpenActivity={() => undefined}
      />,
    );
    expect(screen.getByText("顾问 1/3")).toBeTruthy();
  });

  it("opens the activity panel from the bar", () => {
    const onOpenActivity = vi.fn();
    render(<RunLiveBar status={status()} onOpenActivity={onOpenActivity} />);

    fireEvent.click(screen.getByText("查看活动"));

    expect(onOpenActivity).toHaveBeenCalledTimes(1);
  });

  it("counts tasks and invocations", () => {
    render(<RunLiveBar status={status()} onOpenActivity={() => undefined} />);

    expect(screen.getByText("任务 2/5")).toBeTruthy();
    expect(screen.getByText("调用 3/64")).toBeTruthy();
  });
});
