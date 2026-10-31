// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunDetail } from "../../web/src/components/run/RunDetail.js";
import {
  approvalLabel,
  artifactRow,
  bindingSummary,
  checkpointLabel,
  gateLabel,
  hasCliBindings,
  hasRoleRows,
  roleRows,
  strategyRows,
  usageRows,
} from "../../web/src/components/run/detail/model.js";
import type { RunState } from "../../web/src/types.js";
import { runState } from "../support/web-fixtures.js";

function richRun(): RunState {
  return runState({
    plan: { summary: "计划摘要", tasks: [] },
    finalQuality: { passed: false, commands: [] },
    advisorConsultations: 1,
    strategy: {
      ...runState().strategy,
      name: "demo",
      explore: { enabled: true },
      advisor: { enabled: true, maxConsultationsPerRun: 3, triggers: ["plan"] },
      roleProfiles: { worker: "p1" },
    },
    profileOverrides: { reviewer: "p2" },
    roleBindings: { worker: { cli: "kimi", model: "m1", reasoning: "high" } },
    approvals: [
      {
        id: "a-1",
        gate: "plan",
        status: "approved",
        summary: "计划通过",
        checkpointId: "c-1",
        requestedAt: "2026-08-11T18:00:00.000Z",
        expiresAt: "2026-08-11T19:00:00.000Z",
        response: { decision: "approved", actor: "op", reason: "ok", at: "2026-08-11T18:30:00.000Z" },
      },
      {
        id: "a-2",
        gate: "final",
        status: "pending",
        summary: "等待交付",
        checkpointId: "c-2",
        requestedAt: "2026-08-11T18:00:00.000Z",
        expiresAt: "2026-08-11T19:00:00.000Z",
      },
    ],
    checkpoints: [
      {
        id: "c-1",
        version: 1,
        stage: "plan-ready",
        integrationCommit: "abcdef0123456789",
        completedTaskIds: ["T1"],
        createdAt: "2026-08-11T18:00:00.000Z",
      },
    ],
    resumeCount: 2,
    usage: {
      agentInvocations: 3,
      agentDurationMs: 90_000,
      processOutputBytes: 2_048,
      artifactBytes: 1_048_576,
      truncatedStreams: 1,
      inputTokens: 1200,
      outputTokens: 800,
      reportedCostUsd: 0.1234,
    },
    finalDecision: { decision: "ready", reason: "all gates passed" },
    error: "spawn codex ENOENT",
  } as unknown as Partial<RunState>);
}

describe("run detail model", () => {
  it("labels approvals, gates and checkpoints", () => {
    expect(approvalLabel("pending")).toBe("待处理");
    expect(approvalLabel("approved")).toBe("已批准");
    expect(approvalLabel("rejected")).toBe("已拒绝");
    expect(gateLabel("plan")).toBe("执行计划");
    expect(gateLabel("final")).toBe("交付结果");
    expect(checkpointLabel("plan-ready")).toBe("计划完成");
    expect(checkpointLabel("unknown-stage")).toBe("unknown-stage");
  });

  it("summarises bindings and role rows", () => {
    expect(bindingSummary(undefined)).toBeUndefined();
    expect(bindingSummary({ cli: "kimi", model: "m1", reasoning: "high" })).toBe("kimi · m1 · high");
    expect(bindingSummary({ cli: "grok" })).toBe("grok · 默认模型");

    const run = richRun();
    const rows = roleRows(run);
    expect(rows.find((row) => row.role === "worker")?.detail).toBe("kimi · m1 · high");
    expect(rows.find((row) => row.role === "reviewer")?.detail).toMatch(/p2|Reviewer|reviewer/i);
    expect(hasRoleRows(run)).toBe(true);
    expect(hasCliBindings(run)).toBe(true);
    // The default fixture carries role profiles but no CLI bindings.
    expect(hasRoleRows(runState())).toBe(
      Object.keys(runState().strategy.roleProfiles).length > 0 ||
        Object.keys(runState().profileOverrides).length > 0,
    );
    expect(hasCliBindings(runState())).toBe(false);
  });

  it("builds strategy and usage rows including the optional ones", () => {
    const run = richRun();
    const strategy = strategyRows(run);
    expect(strategy.map((row) => row.term)).toContain("架构顾问");
    expect(strategy.map((row) => row.term)).toContain("顾问触发");

    const usage = usageRows(run);
    expect(usage.map((row) => row.term)).toContain("已报告 Token");
    expect(usage.map((row) => row.term)).toContain("已报告成本");
    expect(artifactRow(run).value).toMatch(/\//);

    const bare = usageRows(runState());
    expect(bare.map((row) => row.term)).not.toContain("已报告 Token");
    expect(bare.map((row) => row.term)).not.toContain("已报告成本");
  });
});

describe("RunDetail", () => {
  it("renders every applicable section for a rich run", () => {
    render(<RunDetail run={richRun()} />);
    expect(screen.getByText(/计划摘要/)).toBeVisible();
    expect(screen.getByText("策略")).toBeVisible();
    expect(screen.getByText("角色分配")).toBeVisible();
    expect(screen.getByText("人工审批")).toBeVisible();
    expect(screen.getByText("恢复边界")).toBeVisible();
    expect(screen.getByText("资源与追踪")).toBeVisible();
    expect(screen.getByText("最终判定")).toBeVisible();
    expect(screen.getByText("执行计划")).toBeVisible();
    expect(screen.getByText("交付结果")).toBeVisible();
  });

  it("keeps a bare run to its summary and strategy", () => {
    render(<RunDetail run={runState()} />);
    expect(screen.getByText("策略")).toBeVisible();
    expect(screen.queryByText("人工审批")).toBeNull();
    expect(screen.queryByText("恢复边界")).toBeNull();
    expect(screen.queryByText("最终判定")).toBeNull();
  });
});
