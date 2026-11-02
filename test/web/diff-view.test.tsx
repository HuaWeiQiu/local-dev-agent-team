// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskDiff } from "../../web/src/types.js";
import { DiffBody, TaskDiffSection } from "../../web/src/components/insights/DiffView.js";

function diff(patch: Partial<TaskDiff> = {}): TaskDiff {
  return {
    taskId: "t1",
    available: true,
    source: "commit",
    changedFiles: ["a.ts", "b.ts"],
    content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+added\n-removed\ndiff header\n@@ -1 +1 @@\ncontext",
    truncated: false,
    ...patch,
  };
}

describe("DiffBody", () => {
  it("explains when there is no diff to show", () => {
    render(<DiffBody diff={diff({ available: false, detail: "任务尚未产生可查看的改动" })} />);

    expect(screen.getByText("任务尚未产生可查看的改动")).toBeTruthy();
  });

  it("falls back to its own wording when the server sends no detail", () => {
    render(<DiffBody diff={diff({ available: false })} />);

    expect(screen.getByText("没有可显示的改动")).toBeTruthy();
  });

  it("says how many files changed, where they came from and whether it was cut", () => {
    render(<DiffBody diff={diff({ truncated: true })} />);

    expect(screen.getByText("2 个文件 · 已提交 · 已截断")).toBeTruthy();
  });

  it("names the worktree as the source when nothing is committed", () => {
    render(<DiffBody diff={diff({ source: "worktree" })} />);

    expect(screen.getByText("2 个文件 · 工作区暂存")).toBeTruthy();
  });

  it("renders every diff line, including blank ones", () => {
    render(<DiffBody diff={diff({ content: "+one\n\n-two" })} />);

    expect(screen.getByLabelText("任务改动").textContent).toContain("+one");
  });
});

describe("TaskDiffSection", () => {
  it("loads the diff on demand and shows it", async () => {
    const onLoad = vi.fn().mockResolvedValue(diff());
    render(<TaskDiffSection taskId="t1" onLoad={onLoad} />);

    fireEvent.click(screen.getByText("查看改动"));

    expect(await screen.findByText("2 个文件 · 已提交")).toBeTruthy();
    expect(onLoad).toHaveBeenCalledWith("t1");
  });

  it("shows the failure when the diff cannot be read", async () => {
    const onLoad = vi.fn().mockRejectedValue(new Error("git 读取失败"));
    render(<TaskDiffSection taskId="t1" onLoad={onLoad} />);

    fireEvent.click(screen.getByText("查看改动"));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "git 读取失败");
  });

  it("reports a non-Error rejection as text", async () => {
    const onLoad = vi.fn().mockRejectedValue("字符串错误");
    render(<TaskDiffSection taskId="t1" onLoad={onLoad} />);

    fireEvent.click(screen.getByText("查看改动"));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "字符串错误");
  });
});
