// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentsPanel } from "../../web/src/components/AgentsPanel.js";

function agent(patch: Record<string, unknown> = {}) {
  return {
    id: "a1",
    role: "worker",
    profile: "codex-worker",
    adapter: "codex",
    model: "gpt-5-codex",
    status: "running",
    taskId: "T1",
    capabilities: { steer: true, interrupt: true, askUser: true },
    questions: [],
    ...patch,
  };
}

function controls(agents: unknown[], patch: Record<string, unknown> = {}) {
  return {
    agents,
    actor: "operator",
    setActor: vi.fn(),
    error: undefined,
    pending: false,
    steer: vi.fn().mockResolvedValue(true),
    interrupt: vi.fn().mockResolvedValue(true),
    answer: vi.fn().mockResolvedValue(true),
    ...patch,
  };
}

function renderPanel(patch: { agent?: Record<string, unknown>; controls?: Record<string, unknown>; events?: RunEvent[] } = {}) {
  const liveAgent = agent(patch.agent);
  return render(
    <AgentsPanel
      runActive
      events={patch.events ?? []}
      controls={controls([liveAgent], patch.controls) as never}
    />,
  );
}

describe("AgentsPanel agent card", () => {
  it("shows the role, the task badge and the awaiting-answer status", () => {
    renderPanel({ agent: { status: "awaiting-answer" } });

    expect(screen.getByText("等待回答")).toBeTruthy();
    expect(screen.getByText("任务 T1")).toBeTruthy();
  });

  it("shows the running status and the adapter/model/profile line", () => {
    renderPanel();

    expect(screen.getByText("执行中")).toBeTruthy();
    expect(screen.getByText("codex · gpt-5-codex · codex-worker")).toBeTruthy();
  });

  it("steers the agent with the trimmed text and clears the box", async () => {
    const steer = vi.fn().mockResolvedValue(true);
    renderPanel({ controls: { steer } });

    fireEvent.change(screen.getByLabelText(/^引导/), { target: { value: "  keep going  " } });
    fireEvent.submit(screen.getByLabelText(/^引导/).closest("form")!);

    await waitFor(() => expect(steer).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "keep going"));
    await waitFor(() => expect(screen.getByLabelText(/^引导/)).toHaveProperty("value", ""));
  });

  it("ignores an empty steer", async () => {
    const steer = vi.fn().mockResolvedValue(true);
    renderPanel({ controls: { steer } });

    fireEvent.submit(screen.getByLabelText(/^引导/).closest("form")!);

    expect(steer).not.toHaveBeenCalled();
  });

  it("explains why a one-shot agent cannot be steered", () => {
    renderPanel({ agent: { capabilities: { steer: false, interrupt: true, askUser: false } } });

    expect(screen.getByText(/无法中途引导/)).toBeTruthy();
  });

  it("opens the interrupt panel and keeps the note when the interrupt fails", async () => {
    const interrupt = vi.fn().mockResolvedValue(false);
    renderPanel({ controls: { interrupt } });

    fireEvent.click(screen.getByText("中断…"));
    fireEvent.change(screen.getByLabelText(/中断并改道/), { target: { value: "换思路" } });
    fireEvent.click(screen.getByText("中断并改道"));

    await waitFor(() => expect(interrupt).toHaveBeenCalled());
    expect(screen.getByLabelText(/中断并改道/)).toHaveProperty("value", "换思路");
  });

  it("closes the interrupt panel and clears the note after a successful interrupt", async () => {
    const interrupt = vi.fn().mockResolvedValue(true);
    renderPanel({ controls: { interrupt } });

    fireEvent.click(screen.getByText("中断…"));
    fireEvent.change(screen.getByLabelText(/中断并改道/), { target: { value: "换思路" } });
    fireEvent.click(screen.getByText("中断并改道"));

    await waitFor(() => expect(screen.queryByLabelText(/中断并改道/)).toBeNull());
    fireEvent.click(screen.getByText("中断…"));
    expect(screen.getByLabelText(/中断并改道/)).toHaveProperty("value", "");
  });

  it("labels the interrupt as ending the attempt when no note is given", () => {
    renderPanel();

    fireEvent.click(screen.getByText("中断…"));

    expect(screen.getByText("中断并结束尝试")).toBeTruthy();
  });

  it("cancels the interrupt panel without interrupting", () => {
    const interrupt = vi.fn();
    renderPanel({ controls: { interrupt } });

    fireEvent.click(screen.getByText("中断…"));
    fireEvent.click(screen.getByText("取消"));

    expect(interrupt).not.toHaveBeenCalled();
    expect(screen.getByText("中断…")).toBeTruthy();
  });

  it("hides the interrupt control for an agent that cannot be interrupted", () => {
    renderPanel({ agent: { capabilities: { steer: true, interrupt: false, askUser: false } } });

    expect(screen.queryByText("中断…")).toBeNull();
  });
});
