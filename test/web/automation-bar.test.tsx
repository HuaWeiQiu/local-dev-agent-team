// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AutomationBar } from "../../web/src/components/evolution/AutomationBar.js";
import {
  automationNote,
  cyclesInputDisabled,
  cycleDecisionLabel,
  isAutomationActive,
  latestCycle,
  noteIsError,
  roleBindingLabel,
  showFooter,
  startDisabled,
} from "../../web/src/components/evolution/automation/model.js";
import type { AutomaticEvolutionSnapshot } from "../../web/src/types.js";

function cycle(seq: number, patch: Record<string, unknown> = {}) {
  return {
    cycle: seq,
    decision: "promoted",
    improved: true,
    scoreDelta: 120,
    incumbentScore: 800,
    candidateScore: 920,
    candidateRunIds: ["run-1"],
    rationale: "更稳",
    completedAt: "2026-10-30T00:00:00.000Z",
    ...patch,
  };
}

function automation(patch: Partial<AutomaticEvolutionSnapshot> = {}): AutomaticEvolutionSnapshot {
  return {
    enabled: true,
    autoStart: false,
    status: "idle",
    phase: "idle",
    configuredMaxCycles: 3,
    requestedMaxCycles: null,
    completedCycles: 1,
    maxConsecutiveNoImprovement: 2,
    consecutiveNoImprovement: 0,
    evaluationRepeats: 1,
    minimumScoreDelta: 150,
    baselineStrategy: null,
    targetStrategy: "demo",
    sessionId: null,
    activeRunId: null,
    incumbentScore: null,
    incumbentStrategy: null,
    stopReason: null,
    error: null,
    failureCode: null,
    roleBindingSource: "global-cli-defaults",
    startedAt: null,
    updatedAt: "2026-10-30T00:00:00.000Z",
    lastEvaluation: null,
    cycles: [],
    ...patch,
  } as AutomaticEvolutionSnapshot;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    automation: automation(),
    requestedCycles: 2,
    busy: false,
    startIntentPending: false,
    mutationLocked: false,
    onCyclesChange: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    ...patch,
  } as never;
}

describe("automation model", () => {
  it("classifies the run state", () => {
    expect(isAutomationActive(automation({ status: "running" }))).toBe(true);
    expect(isAutomationActive(automation({ status: "stopping" }))).toBe(true);
    expect(isAutomationActive(automation({ status: "idle" }))).toBe(false);

    expect(automationNote(automation({ error: "boom" }))).toBe("boom");
    expect(automationNote(automation({ status: "running", stopReason: "ignored" }))).toBeUndefined();
    expect(automationNote(automation({ stopReason: "manual stop" }))).toBe("manual stop");
    expect(noteIsError(automation({ status: "paused" }))).toBe(true);
    expect(noteIsError(automation({}))).toBe(false);
  });

  it("labels bindings, decisions and the footer", () => {
    expect(roleBindingLabel("layered-cli-defaults")).toBe("全局/项目默认");
    expect(roleBindingLabel("project-yaml")).toBe("项目 yaml");
    expect(roleBindingLabel(null)).toBe("项目 yaml");
    expect(cycleDecisionLabel(cycle(1) as never)).toBe("已采纳");
    expect(cycleDecisionLabel(cycle(1, { decision: "rejected" }) as never)).toBe("未采纳");
    expect(showFooter(automation({}))).toBe(false);
    expect(showFooter(automation({ cycles: [cycle(1)] as never }))).toBe(true);
    expect(showFooter(automation({ stopReason: "done" }))).toBe(true);
    expect(latestCycle(automation({ cycles: [cycle(1), cycle(2)] as never }))?.cycle).toBe(2);
  });

  it("decides when start and the cycle input are disabled", () => {
    const base = { automation: automation(), busy: false, mutationLocked: false, startIntentPending: false };
    expect(startDisabled(base)).toBe(false);
    expect(startDisabled({ ...base, automation: automation({ enabled: false }) })).toBe(true);
    expect(startDisabled({ ...base, busy: true })).toBe(true);
    expect(startDisabled({ ...base, mutationLocked: true })).toBe(true);
    expect(cyclesInputDisabled(base)).toBe(false);
    expect(cyclesInputDisabled({ ...base, startIntentPending: true })).toBe(true);
    expect(cyclesInputDisabled({ ...base, automation: automation({ configuredMaxCycles: 0 }) })).toBe(true);
  });
});

describe("AutomationBar", () => {
  it("summarizes an idle loop and starts it", async () => {
    const onStart = vi.fn();
    render(<AutomationBar {...props({ onStart })} />);
    expect(screen.getByText("自动演进")).toBeVisible();
    expect(screen.getByRole("group", { name: "自动演进限制" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /开始/ }));
    expect(onStart).toHaveBeenCalled();
  });

  it("shows the stop control while running", async () => {
    const onStop = vi.fn();
    render(<AutomationBar {...props({ automation: automation({ status: "running" }), onStop })} />);
    await userEvent.click(screen.getByRole("button", { name: /停止/ }));
    expect(onStop).toHaveBeenCalled();
  });

  it("disables stop while the loop is already stopping", () => {
    render(<AutomationBar {...props({ automation: automation({ status: "stopping" }) })} />);
    expect(screen.getByRole("button", { name: /正在停止/ })).toBeDisabled();
  });

  it("shows the disabled project state without limits", () => {
    render(<AutomationBar {...props({ automation: automation({ enabled: false }) })} />);
    expect(screen.getByText("当前项目未启用")).toBeVisible();
    expect(screen.queryByRole("group", { name: "自动演进限制" })).toBeNull();
    expect(screen.getByRole("button", { name: /开始/ })).toBeDisabled();
  });

  it("renders an error note with its failure code", () => {
    render(
      <AutomationBar
        {...props({ automation: automation({ error: "boom", failureCode: "MODEL_DOWN" }) })}
      />,
    );
    expect(screen.getByText(/MODEL_DOWN/)).toBeVisible();
    expect(screen.getByText(/boom/)).toBeVisible();
  });

  it("renders a plain stop reason without an alert", () => {
    render(<AutomationBar {...props({ automation: automation({ stopReason: "manual" }) })} />);
    expect(screen.getByText("manual")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("expands the cycle history", async () => {
    render(<AutomationBar {...props({ automation: automation({ cycles: [cycle(1), cycle(2)] }) })} />);
    const toggle = screen.getByRole("button", { name: /轮次明细（2）/ });
    expect(screen.queryByText("第 1 轮")).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByText("第 2 轮")).toBeVisible();
    expect(screen.getAllByText(/关联运行/).length).toBeGreaterThan(0);
  });

  it("clamps a typed cycle count", async () => {
    const onCyclesChange = vi.fn();
    render(<AutomationBar {...props({ onCyclesChange })} />);
    const input = screen.getByRole("spinbutton");
    await userEvent.clear(input);
    await userEvent.type(input, "9");
    expect(onCyclesChange).toHaveBeenCalled();
    const last = onCyclesChange.mock.calls.at(-1)?.[0];
    expect(last).toBeLessThanOrEqual(3);
  });
});
