// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StageDetail } from "../../web/src/components/architecture/StageDetail.js";
import {
  agentStatusLabel,
  agentTone,
} from "../../web/src/components/architecture/stage/sections.js";
import type { StageBrief } from "../../web/src/architecture.js";
import type { TaskRunState } from "../../web/src/types.js";

function task(id: string): TaskRunState {
  return {
    task: { id, title: `任务 ${id}`, description: "", dependsOn: [], ownedPaths: [], acceptanceCommands: [] },
    status: "working",
    attempts: 1,
  } as unknown as TaskRunState;
}

function brief(patch: Partial<StageBrief> = {}): StageBrief {
  return {
    stage: { id: "build", label: "构建", state: "current" },
    headline: "正在构建",
    hint: "把任务分派下去",
    history: [],
    agents: [],
    ledger: [],
    tasks: [],
    ...patch,
  } as unknown as StageBrief;
}

describe("stage agent labels", () => {
  it("maps status to tone and label", () => {
    expect(agentTone("running")).toBe("active");
    expect(agentTone("failed")).toBe("danger");
    expect(agentTone("done")).toBe("success");
    expect(agentStatusLabel("running")).toBe("执行中");
    expect(agentStatusLabel("failed")).toBe("失败");
    expect(agentStatusLabel("done")).toBe("完成");
  });
});

describe("StageDetail", () => {
  it("shows the header with the stage state", () => {
    render(<StageDetail brief={brief()} onSelectTask={() => undefined} />);
    expect(screen.getByText("进行中")).toBeVisible();
    expect(screen.getByText("构建")).toBeVisible();
    expect(screen.getByText("正在构建")).toBeVisible();
  });

  it("renders input, artifact and live output", () => {
    render(
      <StageDetail
        brief={brief({
          input: "计划摘要",
          artifact: { title: "探索摘要", body: "找到 3 个模块" },
          liveText: "编译中…",
        })}
        onSelectTask={() => undefined}
      />,
    );
    expect(screen.getByText("计划摘要")).toBeVisible();
    expect(screen.getByText("结果 · 探索摘要")).toBeVisible();
    expect(screen.getByText("编译中…")).toBeVisible();
  });

  it("lists agents with their status badges", () => {
    render(
      <StageDetail
        brief={brief({
          agents: [
            { role: "worker", label: "执行者", status: "running" },
            { role: "reviewer", label: "审查者", status: "failed", note: "timeout" },
          ],
        })}
        onSelectTask={() => undefined}
      />,
    );
    expect(screen.getByText("执行中")).toBeVisible();
    expect(screen.getByText("失败")).toBeVisible();
    expect(screen.getByText("timeout")).toBeVisible();
  });

  it("shows retries, ledger and falls back to history", () => {
    const { rerender } = render(
      <StageDetail
        brief={brief({
          retries: 2,
          ledger: [{ at: "2026-10-30T00:00:00.000Z", label: "开始一批任务", detail: "T1、T2" }],
          history: [{ at: "2026-10-30T00:00:00.000Z", message: "历史消息" }],
        })}
        onSelectTask={() => undefined}
      />,
    );
    expect(screen.getByText(/额外尝试了 2 次/)).toBeVisible();
    expect(screen.getByText("开始一批任务")).toBeVisible();
    expect(screen.queryByText("历史消息")).toBeNull();

    rerender(
      <StageDetail
        brief={brief({ history: [{ at: "2026-10-30T00:00:00.000Z", message: "历史消息" }] })}
        onSelectTask={() => undefined}
      />,
    );
    expect(screen.getByText("历史消息")).toBeVisible();
  });

  it("selects a task from the list", async () => {
    const onSelectTask = vi.fn();
    render(<StageDetail brief={brief({ tasks: [task("T1")] })} onSelectTask={onSelectTask} />);
    await userEvent.click(screen.getByRole("button", { name: /任务 T1/ }));
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ id: "T1" }) }));
  });
});
