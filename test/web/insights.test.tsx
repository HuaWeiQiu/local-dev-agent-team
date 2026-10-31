// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CostView } from "../../web/src/components/insights/CostView.js";
import { TaskDiffSection } from "../../web/src/components/insights/DiffView.js";
import { ReplayView } from "../../web/src/components/insights/ReplayView.js";
import { TranscriptView } from "../../web/src/components/insights/TranscriptView.js";
import { WhyView } from "../../web/src/components/insights/WhyView.js";
import type {
  ReplayStep,
  RunUsageBreakdown,
  TaskDiff,
  Transcript,
  TranscriptSummary,
  UsageLine,
} from "../../web/src/types.js";

const line = (overrides: Partial<UsageLine> = {}): UsageLine => ({
  invocations: 2,
  failures: 0,
  durationMs: 65_000,
  inputTokens: 1_000,
  cachedInputTokens: 0,
  outputTokens: 200,
  costUsd: 0.5,
  costReported: true,
  ...overrides,
});

describe("WhyView", () => {
  it("shows the headline, flow reason and per-task evidence", () => {
    render(
      <WhyView
        explanation={{
          headline: { tone: "bad", text: "已阻塞：任务 T1 重复失败" },
          flow: { template: "quick", source: "router", reasons: ["小改动"] },
          run: [{ tone: "good", text: "最终集成质量门禁通过" }],
          tasks: [
            {
              taskId: "T1",
              title: "修复拼写",
              status: "blocked",
              tone: "bad",
              summary: "Stopped after a repeated identical failure",
              lines: [{ tone: "bad", text: "质量命令失败：pnpm test（退出码 1）" }],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("已阻塞：任务 T1 重复失败")).toBeInTheDocument();
    expect(screen.getByText(/流程 quick（router）：小改动/)).toBeInTheDocument();
    expect(screen.getByText("质量命令失败：pnpm test（退出码 1）")).toBeInTheDocument();
    expect(screen.getByText("修复拼写")).toBeInTheDocument();
  });
});

describe("CostView", () => {
  it("separates run-level spend from task spend and marks unknown cost", () => {
    const usage: RunUsageBreakdown = {
      total: line({ invocations: 3 }),
      byRole: [{ role: "worker", ...line() }],
      byTask: [{ taskId: "T1", ...line({ failures: 1 }) }],
      byProfile: [{ profile: "codex", model: "gpt-5", ...line({ costReported: false, costUsd: 0 }) }],
      unattributed: line({ invocations: 1 }),
    };
    render(<CostView usage={usage} />);
    expect(screen.getByRole("table", { name: "按任务" })).toBeInTheDocument();
    expect(screen.getByText("运行级")).toBeInTheDocument();
    expect(screen.getAllByText("未上报").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.50").length).toBeGreaterThan(0);
  });
});

describe("TranscriptView", () => {
  const summaries: TranscriptSummary[] = [
    { id: "tasks/T1/attempt-1/worker/codex", artifactKey: "tasks/T1/attempt-1/worker", profile: "codex", role: "worker", taskId: "T1", live: true, bytes: 10 },
    { id: "tasks/T2/attempt-1/worker/codex", artifactKey: "tasks/T2/attempt-1/worker", profile: "codex", role: "worker", taskId: "T2", live: false, bytes: 10 },
  ];
  const transcript = (id: string): Transcript => ({
    id,
    truncated: false,
    entries: [
      { kind: "message", text: `hello from ${id}` },
      { kind: "tool", label: "shell", status: "completed", text: "ls" },
      { kind: "operator", label: "steer", text: "lead: be careful" },
    ],
  });

  it("loads the first invocation and switches when another is selected", async () => {
    const onLoad = vi.fn(async (id: string) => transcript(id));
    render(<TranscriptView transcripts={summaries} onLoad={onLoad} />);
    expect(await screen.findByText("hello from tasks/T1/attempt-1/worker/codex")).toBeInTheDocument();
    expect(screen.getByText("lead: be careful")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button")[1]!);
    expect(await screen.findByText("hello from tasks/T2/attempt-1/worker/codex")).toBeInTheDocument();
  });

  it("filters to one task and shows a read failure", async () => {
    const onLoad = vi.fn(async () => {
      throw new Error("Transcript path contains an invalid segment");
    });
    render(<TranscriptView transcripts={summaries} taskId="T2" onLoad={onLoad} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid segment");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("explains an empty list", () => {
    render(<TranscriptView transcripts={[]} onLoad={vi.fn()} />);
    expect(screen.getByText("还没有智能体对话记录")).toBeInTheDocument();
  });
});

describe("ReplayView", () => {
  const steps: ReplayStep[] = [
    { at: "2026-01-01T00:00:00Z", offsetMs: 0, kind: "flow", tone: "neutral", title: "plan started", nodeId: "plan" },
    { at: "2026-01-01T00:00:05Z", offsetMs: 5_000, kind: "flow", tone: "good", title: "plan completed", nodeId: "plan" },
    { at: "2026-01-01T00:00:09Z", offsetMs: 9_000, kind: "triage", tone: "bad", title: "T1 stop", detail: "same failure", taskId: "T1" },
  ];

  it("starts at the end and scrubs back to the start", () => {
    render(<ReplayView steps={steps} />);
    const slider = screen.getByRole("slider", { name: "回放进度" });
    expect(slider).toHaveValue("3");
    expect(screen.getByRole("list", { name: "阶段状态" })).toHaveTextContent("plan · completed");

    fireEvent.change(slider, { target: { value: "1" } });
    expect(screen.getByRole("list", { name: "阶段状态" })).toHaveTextContent("plan · started");
    const items = screen.getAllByRole("listitem").filter((item) => item.getAttribute("aria-current"));
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("plan started");
  });

  it("says so when there is nothing to replay", () => {
    render(<ReplayView steps={[]} />);
    expect(screen.getByText("还没有可回放的过程")).toBeInTheDocument();
  });
});

describe("TaskDiffSection", () => {
  it("loads the diff only when asked and colours added and removed lines", async () => {
    const diff: TaskDiff = {
      taskId: "T1",
      available: true,
      source: "commit",
      changedFiles: ["a.txt"],
      content: "diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n-zero",
      truncated: false,
    };
    const onLoad = vi.fn(async () => diff);
    render(<TaskDiffSection taskId="T1" onLoad={onLoad} />);
    expect(onLoad).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "查看改动" }));
    await waitFor(() => expect(screen.getByLabelText("任务改动")).toBeInTheDocument());
    expect(onLoad).toHaveBeenCalledWith("T1");
    expect(screen.getByText("+two").className).toContain("success");
    expect(screen.getByText("-zero").className).toContain("danger");
  });

  it("shows why there is no diff", async () => {
    const onLoad = vi.fn(async (): Promise<TaskDiff> => ({
      taskId: "T1",
      available: false,
      changedFiles: [],
      truncated: false,
      detail: "任务尚未产生可查看的改动",
    }));
    render(<TaskDiffSection taskId="T1" onLoad={onLoad} />);
    await userEvent.click(screen.getByRole("button", { name: "查看改动" }));
    expect(await screen.findByText("任务尚未产生可查看的改动")).toBeInTheDocument();
  });
});
