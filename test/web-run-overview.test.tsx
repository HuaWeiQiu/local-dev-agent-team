// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunOverview } from "../web/src/components/RunOverview.js";
import {
  completedTasks,
  decisionLabel,
  elapsedLabel,
  headlineToneClass,
  isTerminal,
  reworkCount,
  summaryStats,
} from "../web/src/components/run/overview/model.js";
import { verdictIcon } from "../web/src/components/run/overview/sections.js";
import type { RunState, TaskRunState } from "../web/src/types.js";
import { runState } from "./support/web-fixtures.js";

const NOW = Date.parse("2026-10-31T00:00:00.000Z");

function task(id: string, patch: Record<string, unknown> = {}): TaskRunState {
  return {
    task: { id, title: `任务 ${id}`, description: "", dependsOn: [], ownedPaths: [`src/${id}.ts`], acceptanceCommands: [] },
    status: "working",
    attempts: 1,
    ...patch,
  } as unknown as TaskRunState;
}

function run(patch: Partial<RunState> = {}): RunState {
  return { ...runState(), tasks: [task("T1")], ...patch } as RunState;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    run: run(),
    events: [],
    onSelectTask: vi.fn(),
    onOpenActivity: vi.fn(),
    ...patch,
  } as never;
}

describe("run overview model", () => {
  it("classifies terminal statuses", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("blocked")).toBe(true);
    expect(isTerminal("ready-to-merge")).toBe(true);
    expect(isTerminal("implementing")).toBe(false);
  });

  it("freezes elapsed time for a finished run", () => {
    const finished = run({ status: "completed", updatedAt: "2026-10-31T00:01:00.000Z" });
    expect(elapsedLabel(finished, NOW)).toBe(elapsedLabel(finished, NOW + 60_000));
    const live = run({ status: "implementing" });
    expect(elapsedLabel(live, NOW)).toBeTruthy();
  });

  it("counts finished tasks and rework", () => {
    const mixed = run({
      tasks: [
        task("T1", { status: "merged", attempts: 3 }),
        task("T2", { status: "passed", attempts: 1 }),
        task("T3", { status: "working", attempts: 2 }),
      ],
    });
    expect(completedTasks(mixed)).toBe(2);
    expect(reworkCount(mixed)).toBe(3);
  });

  it("summarizes usage, cost and calls", () => {
    const withCost = summaryStats(
      run({ usage: { agentInvocations: 4, reportedCostUsd: 1.234 } as never }),
      NOW,
    );
    expect(withCost.map((stat) => stat.label)).toEqual(["耗时", "调用", "成本", "返工"]);
    expect(withCost[1]?.value).toMatch(/^4\//);
    expect(withCost[2]?.value).toBe("$1.23");

    const noCost = summaryStats(run({ usage: undefined }), NOW);
    expect(noCost[2]?.value).toBe("—");
  });

  it("maps headline tones and decisions", () => {
    expect(headlineToneClass("good")).toContain("success");
    expect(headlineToneClass("bad")).toContain("danger");
    expect(headlineToneClass("warn")).toContain("warning");
    expect(headlineToneClass(undefined)).toContain("ink-2");
    expect(decisionLabel("ready")).toBe("总控：可交付");
    expect(decisionLabel("escalate")).toBe("总控：需升级");
  });

  it("picks an icon for every verdict", () => {
    expect(verdictIcon("approve")).toBeTruthy();
    expect(verdictIcon(undefined, true)).toBeTruthy();
    expect(verdictIcon("request_changes")).toBeTruthy();
    expect(verdictIcon(undefined, false)).toBeTruthy();
    expect(verdictIcon("escalate")).toBeTruthy();
    expect(verdictIcon(undefined)).toBeTruthy();
  });
});

describe("RunOverview", () => {
  it("asks for a run when none is selected", () => {
    render(<RunOverview {...(props({ run: undefined }) as object)} />);
    expect(screen.getByText("选择一个运行查看概览")).toBeVisible();
  });

  it("shows the failure banner and the conclusion", () => {
    render(
      <RunOverview
        {...(props({
          run: run({ error: "spawn codex ENOENT" }),
          headline: { text: "任务 T1 卡在 CI", tone: "warn" },
        }) as object)}
      />,
    );
    expect(screen.getByText("运行没有完成")).toBeVisible();
    expect(screen.getByText("结论")).toBeVisible();
    expect(screen.getByText("任务 T1 卡在 CI")).toBeVisible();
  });

  it("renders the plan, the decision and the task table", async () => {
    const onSelectTask = vi.fn();
    render(
      <RunOverview
        {...(props({
          run: run({
            plan: { summary: "先拆分再并行", tasks: [] } as never,
            finalDecision: { decision: "ready", reason: "全部通过" } as never,
          }),
          onSelectTask,
        }) as object)}
      />,
    );
    expect(screen.getByText("先拆分再并行")).toBeVisible();
    expect(screen.getByText("总控：可交付")).toBeVisible();
    expect(screen.getByRole("table", { name: "任务概览" })).toBeTruthy();
    await userEvent.click(screen.getByText("任务 T1"));
    expect(onSelectTask).toHaveBeenCalled();
    const row = screen.getByText("任务 T1").closest("tr")!;
    row.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelectTask).toHaveBeenCalledTimes(2);
    await userEvent.keyboard("{Space}");
    expect(onSelectTask).toHaveBeenCalledTimes(2);
  });

  it("explains an empty task list", () => {
    render(<RunOverview {...(props({ run: run({ tasks: [] }) }) as object)} />);
    expect(screen.getByText("还没有拆分出任务")).toBeVisible();
  });

  it("shows the decision without a plan", () => {
    render(
      <RunOverview
        {...(props({ run: run({ finalDecision: { decision: "escalate", reason: "需要人工" } as never }) }) as object)}
      />,
    );
    expect(screen.getByText("总控：需升级")).toBeVisible();
    expect(screen.queryByText("计划")).toBeNull();
  });

  it("summarizes the run and lists recent activity", async () => {
    const onOpenActivity = vi.fn();
    render(
      <RunOverview
        {...(props({
          events: [
            {
              id: "e1",
              sequence: 1,
              schemaVersion: 1,
              runId: "r",
              type: "agent.invocation.started",
              occurredAt: "2026-10-31T00:00:00.000Z",
              payload: { role: "worker" },
              traceId: "a".repeat(32),
              spanId: "b".repeat(16),
            },
          ],
          onOpenActivity,
        }) as object)}
      />,
    );
    expect(screen.getByRole("complementary", { name: "运行摘要" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(onOpenActivity).toHaveBeenCalled();
  });

  it("says there is no activity yet", () => {
    // A run whose history is empty produces no timeline entries.
    render(<RunOverview {...(props({ run: run({ history: [] }) }) as object)} />);
    expect(screen.getByText("暂无事件")).toBeVisible();
  });
});
