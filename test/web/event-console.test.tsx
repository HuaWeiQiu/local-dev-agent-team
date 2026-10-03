// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EventConsole } from "../../web/src/components/EventConsole.js";
import { runEvent, runState } from "../support/web-fixtures.js";

const events = [
  runEvent(1, "agent.invocation.started", { invocationId: "i1", role: "worker", profile: "codex-worker", adapter: "codex" }),
  runEvent(2, "agent.profile.failed", { role: "worker", profile: "codex-worker", failure: { message: "额度用尽" } }),
  runEvent(3, "approval.requested", { gate: "plan" }),
];

describe("EventConsole activity timeline", () => {
  it("lists typed entries and filters them by kind", async () => {
    render(<EventConsole run={runState()} events={events} connected onExport={() => undefined} />);
    await userEvent.click(screen.getByRole("tab", { name: /活动/ }));

    expect(screen.getByText("额度用尽")).toBeInTheDocument();
    expect(screen.getByText("等待人工审批")).toBeInTheDocument();

    const filters = screen.getByRole("group", { name: "活动类型筛选" });
    await userEvent.click(within(filters).getByRole("button", { name: /异常/ }));
    expect(screen.getByText("额度用尽")).toBeInTheDocument();
    expect(screen.queryByText("等待人工审批")).not.toBeInTheDocument();

    await userEvent.click(within(filters).getByRole("button", { name: /异常/ }));
    expect(screen.getByText("等待人工审批")).toBeInTheDocument();
  });

  it("asks to pick a run when none is selected", async () => {
    render(<EventConsole run={undefined} events={[]} connected={false} onExport={() => undefined} />);
    await userEvent.click(screen.getByRole("tab", { name: /活动/ }));
    expect(screen.getByText("选择运行后显示活动")).toBeInTheDocument();
  });
});
