// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentsPanel } from "../../web/src/components/AgentsPanel.js";
import { PlanEditor, planDraftProblem, type EditablePlan } from "../../web/src/components/PlanEditor.js";
import type { LiveAgentControls } from "../../web/src/hooks/useLiveAgents.js";
import type { LiveAgent, Task } from "../../web/src/types.js";

function agent(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    id: "a1",
    runId: "r1",
    role: "worker",
    artifactKey: "T1-worker",
    taskId: "T1",
    profile: "codex-worker",
    adapter: "codex",
    model: "gpt-5",
    kind: "codex-app-server",
    capabilities: { steer: true, interrupt: true, askUser: true, resume: false },
    startedAt: "2026-10-03T10:00:00Z",
    lastActivityAt: "2026-10-03T10:00:00Z",
    status: "running",
    questions: [],
    ...overrides,
  };
}

function controls(agents: LiveAgent[], overrides: Partial<LiveAgentControls> = {}): LiveAgentControls {
  return {
    agents,
    actor: "lead",
    setActor: vi.fn(),
    error: undefined,
    pending: false,
    steer: vi.fn().mockResolvedValue(true),
    interrupt: vi.fn().mockResolvedValue(true),
    answer: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("AgentsPanel", () => {
  it("shows an empty state when nothing is running", () => {
    render(<AgentsPanel events={[]} controls={controls([])} runActive />);
    expect(screen.getByText("当前没有运行中的智能体")).toBeInTheDocument();
  });

  it("steers a live agent", async () => {
    const live = controls([agent()]);
    render(<AgentsPanel events={[]} controls={live} runActive />);
    await userEvent.type(screen.getByLabelText("引导执行"), "use approach B");
    await userEvent.click(screen.getByRole("button", { name: "引导" }));
    expect(live.steer).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "use approach B");
  });

  it("interrupts with a redirect note", async () => {
    const live = controls([agent()]);
    render(<AgentsPanel events={[]} controls={live} runActive />);
    await userEvent.click(screen.getByRole("button", { name: "中断…" }));
    await userEvent.type(screen.getByPlaceholderText("新的指令（可选）"), "skip refactor");
    await userEvent.click(screen.getByRole("button", { name: "中断并改道" }));
    expect(live.interrupt).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "skip refactor");
  });

  it("answers a question by option and masks secret input", async () => {
    const question = { questionId: "q1", prompt: "Which option?", options: ["A", "B"], secret: false, askedAt: "t" };
    const live = controls([agent({ status: "awaiting-answer", questions: [question] })]);
    const { rerender } = render(<AgentsPanel events={[]} controls={live} runActive />);
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    expect(live.answer).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "q1", "B");

    rerender(
      <AgentsPanel
        events={[]}
        controls={controls([agent({ questions: [{ ...question, secret: true, options: undefined as never }] })])}
        runActive
      />,
    );
    expect(screen.getByLabelText("你的回答")).toHaveAttribute("type", "password");
  });

  it("explains that one-shot agents cannot be steered", () => {
    const oneShot = agent({ kind: "one-shot", capabilities: { steer: false, interrupt: false, askUser: false, resume: false } });
    render(<AgentsPanel events={[]} controls={controls([oneShot])} runActive />);
    expect(screen.getByText(/无法中途引导/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "中断…" })).toBeNull();
  });
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}`,
  dependsOn: [],
  ownedPaths: [`${id}.txt`],
  acceptanceCommands: [],
  profile: null,
  ...extra,
});

describe("PlanEditor", () => {
  it("edits titles, adds tasks with fresh ids and prunes dependencies on delete", async () => {
    const changes: EditablePlan[] = [];
    const plan: EditablePlan = { summary: "S", tasks: [task("T1"), task("T2", { dependsOn: ["T1"] })] };
    const { rerender } = render(<PlanEditor plan={plan} onChange={(next) => changes.push(next)} />);

    await userEvent.type(screen.getByLabelText("标题", { selector: "#plan-title-T1" }), "!");
    expect(changes.at(-1)?.tasks[0]?.title).toBe("Task T1!");

    await userEvent.click(screen.getByRole("button", { name: "添加任务" }));
    expect(changes.at(-1)?.tasks.map((item) => item.id)).toEqual(["T1", "T2", "T3"]);

    rerender(<PlanEditor plan={plan} onChange={(next) => changes.push(next)} />);
    await userEvent.click(screen.getAllByRole("button", { name: "删除任务" })[0]!);
    expect(changes.at(-1)?.tasks.map((item) => [item.id, item.dependsOn])).toEqual([["T2", []]]);
  });

  it("reports why a draft cannot be submitted", () => {
    expect(planDraftProblem({ summary: "S", tasks: [] })).toMatch(/至少需要一个任务/);
    expect(planDraftProblem({ summary: "S", tasks: [task("T1", { title: " " })] })).toMatch(/缺少标题/);
    expect(planDraftProblem({ summary: "S", tasks: [task("T1", { ownedPaths: [] })] })).toMatch(/负责路径/);
    expect(planDraftProblem({ summary: "S", tasks: [task("T1", { dependsOn: ["ghost"] })] })).toMatch(/不存在/);
    expect(planDraftProblem({ summary: "S", tasks: [task("T1")] })).toBeUndefined();
  });
});
