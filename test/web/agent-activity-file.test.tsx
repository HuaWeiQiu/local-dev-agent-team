// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AdvisorLogEntry, AgentInvocationActivity } from "../../web/src/agent-activity.js";
import { AgentActivity } from "../../web/src/components/run/AgentActivity.js";

function invocation(
  patch: Partial<AgentInvocationActivity> = {},
): AgentInvocationActivity {
  return {
    id: "inv-1",
    role: "worker",
    profile: "codex-worker",
    adapter: "codex",
    status: "running",
    startedAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:01:00.000Z",
    children: [],
    ...patch,
  };
}

function advisorEntry(patch: Partial<AdvisorLogEntry> = {}): AdvisorLogEntry {
  return {
    sequence: 1,
    status: "consulted",
    trigger: "rework",
    occurredAt: "2026-11-02T00:02:00.000Z",
    ...patch,
  };
}

describe("AgentActivity", () => {
  it("shows the empty state that matches the run state", () => {
    const { rerender } = render(
      <AgentActivity hasRun={false} activity={[]} advisorLog={[]} advisorUsage={undefined} />,
    );
    expect(screen.getByText("选择运行后显示角色")).toBeTruthy();

    rerender(
      <AgentActivity hasRun activity={[]} advisorLog={[]} advisorUsage={undefined} />,
    );
    expect(screen.getByText("等待角色启动")).toBeTruthy();
  });

  it("renders one row per invocation with its profile, adapter and model", () => {
    render(
      <AgentActivity
        hasRun
        activity={[invocation({ model: "gpt-5-codex" })]}
        advisorLog={[]}
        advisorUsage={undefined}
      />,
    );

    expect(screen.getByText(/codex-worker/)).toBeTruthy();
    expect(screen.getByText(/gpt-5-codex/)).toBeTruthy();
  });

  it("marks an advisor invocation and omits the model when the profile inherits it", () => {
    render(
      <AgentActivity
        hasRun
        activity={[invocation({ advisor: true })]}
        advisorLog={[]}
        advisorUsage={undefined}
      />,
    );

    expect(screen.getByText("顾问")).toBeTruthy();
    expect(screen.getByText("codex-worker · codex")).toBeTruthy();
  });

  it("indents native child agents and shortens a long thread id", () => {
    render(
      <AgentActivity
        hasRun
        activity={[
          invocation({
            children: [
              {
                id: "child-1",
                threadId: "0123456789abcdef",
                label: "子代理",
                status: "completed",
                model: "gpt-5-codex-mini",
                updatedAt: "2026-11-02T00:03:00.000Z",
              },
            ],
          }),
        ]}
        advisorLog={[]}
        advisorUsage={undefined}
      />,
    );

    expect(screen.getByText(/01234567…/)).toBeTruthy();
    expect(screen.getByText(/gpt-5-codex-mini/)).toBeTruthy();
  });

  it("keeps a short thread id whole", () => {
    render(
      <AgentActivity
        hasRun
        activity={[
          invocation({
            children: [
              {
                id: "child-2",
                threadId: "abc",
                label: "子代理",
                status: "completed",
                updatedAt: "2026-11-02T00:03:00.000Z",
              },
            ],
          }),
        ]}
        advisorLog={[]}
        advisorUsage={undefined}
      />,
    );

    expect(screen.getByText(/abc/)).toBeTruthy();
  });

  it("renders the advisor card with its usage and one row per entry", () => {
    render(
      <AgentActivity
        hasRun
        activity={[]}
        advisorLog={[advisorEntry(), advisorEntry({ sequence: 2, status: "skipped" })]}
        advisorUsage="1/3"
      />,
    );

    expect(screen.getByLabelText("架构顾问记录")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("已达本次运行的顾问次数上限，已跳过")).toBeTruthy();
  });

  it("labels a Jev entry and appends the task id when there is one", () => {
    render(
      <AgentActivity
        hasRun
        activity={[]}
        advisorLog={[
          advisorEntry({
            jev: {
              source: "jev",
              decision: "retry",
              consult: true,
              changedOutcome: false,
            },
            taskId: "T2",
          }),
        ]}
        advisorUsage={undefined}
      />,
    );

    expect(screen.getByText(/Jev 分流 · T2/)).toBeTruthy();
  });

  it("explains a consulted recommendation and its summary", () => {
    render(
      <AgentActivity
        hasRun
        activity={[]}
        advisorLog={[advisorEntry({ status: "consulted", recommendation: "approve", summary: "看起来没问题" })]}
        advisorUsage={undefined}
      />,
    );

    expect(screen.getByText(/看起来没问题/)).toBeTruthy();
  });

  it("explains a failure with its detail", () => {
    render(
      <AgentActivity
        hasRun
        activity={[]}
        advisorLog={[advisorEntry({ status: "failed", detail: "timeout" })]}
        advisorUsage={undefined}
      />,
    );

    expect(screen.getByText(/timeout/)).toBeTruthy();
  });
});
