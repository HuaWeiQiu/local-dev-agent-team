// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskDetail } from "../../web/src/components/run/TaskDetail.js";
import {
  commandText,
  dependsLabel,
  evidenceLabel,
  findingLocation,
  hasReview,
  showRunError,
  taskProfile,
} from "../../web/src/components/run/detail/task-model.js";
import type { RunState, TaskRunState } from "../../web/src/types.js";
import { runState } from "../support/web-fixtures.js";

function task(patch: Record<string, unknown> = {}): TaskRunState {
  return {
    task: {
      id: "T1",
      title: "任务 T1",
      description: "做点事",
      dependsOn: [],
      ownedPaths: ["src/a.ts", "src/b.ts"],
      acceptanceCommands: [],
      profile: null,
    },
    status: "working",
    attempts: 1,
    ...patch,
  } as unknown as TaskRunState;
}

function quality(passed: boolean) {
  return {
    passed,
    commands: [
      { spec: { command: "pnpm", args: ["test"] }, exitCode: passed ? 0 : 1, durationMs: 1200 },
    ],
  };
}

describe("task detail model", () => {
  it("resolves profile, dependencies and evidence labels", () => {
    expect(taskProfile(task())).toBeUndefined();
    expect(taskProfile(task({ profile: "p1" }))).toBe("p1");
    expect(taskProfile({ ...task(), task: { ...task().task, profile: "p2" } })).toBe("p2");
    expect(dependsLabel(task().task)).toBe("无");
    expect(dependsLabel({ ...task().task, dependsOn: ["T0", "T2"] })).toBe("T0, T2");
    expect(evidenceLabel(task().task)).toBe("仓库命令 / 审查");
    expect(evidenceLabel({ ...task().task, evidenceKind: "host-evidence" })).toBe("实机证据");
  });

  it("formats commands, findings and run-error visibility", () => {
    expect(commandText({ spec: { command: "pnpm", args: ["test", "--watch"] } })).toBe("pnpm test --watch");
    expect(findingLocation({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(findingLocation({ path: "src/a.ts", line: 7 })).toBe("src/a.ts:7");
    expect(findingLocation({ path: "src/a.ts", line: null })).toBe("src/a.ts");
    expect(showRunError(undefined, undefined)).toBe(false);
    expect(showRunError("same", "same")).toBe(false);
    expect(showRunError("task", "run")).toBe(true);
    expect(hasReview(task())).toBe(false);
    expect(hasReview(task({ review: {} }))).toBe(true);
    expect(hasReview(task({ test: {} }))).toBe(true);
  });
});

describe("TaskDetail", () => {
  it("renders the contract, execution, paths and quality rows", () => {
    render(
      <TaskDetail
        task={task({
          profile: "p1",
          branch: "agent-team/run/t1",
          commit: "abcdef0123456789",
          quality: quality(true),
        })}
      />,
    );
    expect(screen.getByText("任务 T1")).toBeVisible();
    expect(screen.getByText("计划合同")).toBeVisible();
    expect(screen.getByText("src/a.ts")).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
    expect(screen.getByLabelText("通过")).toBeTruthy();
    expect(screen.getByText(/1200 ms/)).toBeVisible();
  });

  it("marks a failing command and shows 'not run' without quality", () => {
    const { rerender } = render(<TaskDetail task={task({ quality: quality(false) })} />);
    expect(screen.getByLabelText("失败")).toBeTruthy();

    rerender(<TaskDetail task={task()} />);
    expect(screen.getByText("尚未执行")).toBeVisible();
  });

  it("renders review verdicts and findings", () => {
    render(
      <TaskDetail
        task={task({
          review: {
            verdict: "request_changes",
            summary: "需要修",
            findings: [{ path: "src/a.ts", line: 3, severity: "high", message: "空指针" }],
          },
          test: { verdict: "approve", summary: "测试通过" },
        })}
      />,
    );
    expect(screen.getByText("审查结论")).toBeVisible();
    expect(screen.getByText("代码审查")).toBeVisible();
    expect(screen.getByText("空指针")).toBeVisible();
    expect(screen.getByText("src/a.ts:3")).toBeVisible();
  });

  it("shows task and run errors once", () => {
    const run = runState({ error: "spawn codex ENOENT" }) as RunState;
    render(<TaskDetail task={task({ error: "task failed" })} run={run} />);
    expect(screen.getAllByText(/失败|错误|找不到/).length).toBeGreaterThan(0);
  });

  it("hides the diff block when there were no attempts", () => {
    render(<TaskDetail task={task({ attempts: 0 })} onLoadDiff={async () => ({ files: [] }) as never} />);
    expect(screen.queryByText("改动")).toBeNull();
  });
});
