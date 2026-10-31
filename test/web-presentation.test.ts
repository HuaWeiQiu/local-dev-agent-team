import { describe, expect, it } from "vitest";
import {
  canvasEmptyCopy,
  formatExperienceTag,
  jevProbeSummary,
  shouldPreserveRoleEdits,
  formatExperienceCondition,
  humanizeFailure,
  jevEntryText,
  morphologySummary,
  profileDisplayName,
  runActionErrorMessage,
  runListSubtitle,
} from "../web/src/presentation.js";
import { ApiError } from "../web/src/api.js";
import type { RunStatus } from "../web/src/types.js";

function run(status: RunStatus, patch: Record<string, unknown> = {}) {
  return { status, tasks: [], taskCounts: {}, strategy: "balanced", ...patch } as never;
}

describe("humanizeFailure", () => {
  it("returns empty for blank input", () => {
    expect(humanizeFailure(undefined)).toBe("");
    expect(humanizeFailure("   ")).toBe("");
  });

  it("names the missing CLI for ENOENT", () => {
    expect(humanizeFailure("spawn codex ENOENT")).toContain("Codex");
    expect(humanizeFailure("spawn grok ENOENT")).toContain("Grok");
    expect(humanizeFailure("spawn other ENOENT")).toBe("spawn other ENOENT");
  });

  it("maps model and control-service failures", () => {
    expect(humanizeFailure("circuit open")).toContain("熔断");
    expect(humanizeFailure("MODEL_QUOTA_EXHAUSTED")).toContain("额度");
    expect(humanizeFailure("rate limit hit")).toContain("限流");
    expect(humanizeFailure("401 unauthorized")).toContain("认证");
    expect(humanizeFailure("owning control service stopped")).toContain("控制服务已关闭");
    expect(humanizeFailure("invalid structured output")).toContain("结构化结果");
  });

  it("names the role whose profiles all failed", () => {
    expect(humanizeFailure("All profiles failed for role 'worker'")).toContain("角色");
    expect(humanizeFailure("All profiles failed for role")).toContain("所有备用模型配置均失败");
  });

  it("keeps the detail of plan and integration failures", () => {
    expect(humanizeFailure("Plan completeness rejected: 缺 T2")).toContain("缺 T2");
    expect(humanizeFailure("Integration quality commands failed: tsc error")).toContain("tsc error");
    expect(humanizeFailure("Integration quality commands failed")).toContain("集成质量门失败");
    expect(humanizeFailure("tsc: command not found")).toContain("缺依赖");
  });

  it("clips a long unrecognised message", () => {
    const long = "x".repeat(400);
    const out = humanizeFailure(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(200);
  });
});

describe("runActionErrorMessage", () => {
  it("reads the API status and code first", () => {
    const session = new ApiError(401, "x", "SESSION_REQUIRED");
    expect(runActionErrorMessage(session)).toContain("控制会话");
    expect(runActionErrorMessage(new ApiError(500, "x", "ORIGIN_DENIED"))).toContain("来源");
    expect(runActionErrorMessage(new ApiError(404, "x", "NOT_FOUND"))).toContain("不存在");
    expect(runActionErrorMessage(new ApiError(413, "x", "REQUEST_TOO_LARGE"))).toContain("过大");
    expect(runActionErrorMessage(new ApiError(409, "x", "CONFLICT"))).toContain("状态已变化");
  });

  it("maps the message text", () => {
    expect(runActionErrorMessage(new Error("Run 'r1' was not found"))).toContain("不存在");
    expect(runActionErrorMessage(new Error("cannot be retried from status merged"))).toContain("不允许重试");
    expect(runActionErrorMessage(new Error("cannot resume from status blocked"))).toContain("不允许继续");
    expect(runActionErrorMessage(new Error("no recoverable task-boundary checkpoint"))).toContain("检查点");
    expect(runActionErrorMessage(new Error("run is already active"))).toContain("已在执行中");
    expect(runActionErrorMessage(new Error("is still active; cancel it first"))).toContain("先取消");
    expect(runActionErrorMessage(new Error("still has an active child run"))).toContain("后续运行的来源");
    expect(runActionErrorMessage(new Error("still referenced as a parent"))).toContain("仍被后续运行引用");
    expect(runActionErrorMessage(new Error("Approval request 'a1' was not found"))).toContain("审批请求");
    expect(runActionErrorMessage(new Error("already has a response"))).toContain("已处理过");
    expect(runActionErrorMessage(new Error("expired at 2026"))).toContain("已过期");
    expect(runActionErrorMessage(new Error("is not the latest request"))).toContain("更新的审批请求");
    expect(runActionErrorMessage(new Error("cannot accept an approval response"))).toContain("不能响应审批");
    expect(runActionErrorMessage(new Error("Cleanup preview is missing or expired"))).toContain("清理预览");
    expect(runActionErrorMessage(new Error("unknown failure"))).toBe("unknown failure");
  });
});

describe("morphologySummary", () => {
  it("summarises the toggles", () => {
    expect(morphologySummary(undefined)).toBe("");
    expect(morphologySummary({})).toBe("探索关 · Swarm ≤1");
    expect(
      morphologySummary({
        maxParallel: 3,
        taskMorphology: { explore: { enabled: true }, advisor: { enabled: true } },
      }),
    ).toBe("探索开 · Swarm ≤3 · 顾问开");
  });

  it("clamps the swarm cap to the parallel limit", () => {
    expect(
      morphologySummary({ maxParallel: 2, taskMorphology: { implement: { swarm: { maxConcurrency: 9 } } } }),
    ).toBe("探索关 · Swarm ≤2");
    expect(morphologySummary({ taskMorphology: { implement: { swarm: { maxConcurrency: 4 } } } }, 5)).toBe(
      "探索关 · Swarm ≤4",
    );
  });
});

describe("profileDisplayName", () => {
  it("falls back through the label table, the hint and the raw name", () => {
    expect(profileDisplayName(undefined)).toBe("未指定");
    expect(profileDisplayName("  ")).toBe("未指定");
    expect(profileDisplayName("worker", { adapter: "codex", model: "gpt" })).toBe("Codex · gpt · worker");
    expect(profileDisplayName("worker", { adapter: "grok", model: "grok" })).toBe("Grok · worker");
    expect(profileDisplayName("worker", { adapter: "custom", model: "inherit" })).toBe("custom · worker");
    expect(profileDisplayName("worker")).toBe("worker");
  });
});

describe("canvasEmptyCopy", () => {
  it("explains each empty state", () => {
    expect(canvasEmptyCopy(undefined).title).toBe("选择一条运行");
    expect(canvasEmptyCopy(run("blocked")).title).toBe("运行已阻塞");
    expect(canvasEmptyCopy(run("cancelled")).title).toBe("运行已取消");
    expect(canvasEmptyCopy(run("interrupted")).title).toBe("运行已中断");
    expect(canvasEmptyCopy(run("exploring")).detail).toContain("只读探索");
    expect(canvasEmptyCopy(run("created")).title).toBe("架构正在拆任务图");
    expect(canvasEmptyCopy(run("architecting")).title).toBe("架构正在拆任务图");
    expect(canvasEmptyCopy(run("failed")).title).toBe("暂无任务节点");
    expect(canvasEmptyCopy(run("failed", { error: "spawn codex ENOENT" })).detail).toContain("Codex");
    expect(canvasEmptyCopy(run("completed", { tasks: [{ id: "T1" }] })).detail).toBe("");
  });
});

describe("runListSubtitle and experience conditions", () => {
  it("describes a run before tasks exist", () => {
    expect(runListSubtitle(run("orchestrating"))).toContain("总控正在分析目标");
    expect(runListSubtitle(run("exploring"))).toContain("只读探索");
    expect(runListSubtitle(run("architecting"))).toContain("架构正在拆分任务");
    expect(runListSubtitle(run("blocked"))).toContain("任务规划前失败");
    expect(runListSubtitle(run("created"))).toBe("尚未拆分任务");
  });

  it("prefers the failure copy and counts finished tasks", () => {
    expect(runListSubtitle(run("failed", { error: "spawn codex ENOENT" }))).toContain("Codex");
    const subtitle = runListSubtitle(run("completed", { taskCounts: { merged: 2, passed: 1, failed: 1 } }));
    expect(subtitle).toContain("3/4");
  });

  it("translates machine conditions and leaves prose alone", () => {
    expect(formatExperienceCondition("")).toBe("");
    expect(formatExperienceCondition("状态已经是完成")).toBe("状态已经是完成");
    expect(formatExperienceCondition("status=completed")).toBe("状态：已完成");
    expect(formatExperienceCondition("tasks=0")).toBe("任务数：0");
  });
});

describe("jevEntryText", () => {
  it("describes a deterministic fallback", () => {
    expect(jevEntryText({ source: "deterministic", consult: true, changedOutcome: false })).toContain(
      "Jev 无响应",
    );
    expect(
      jevEntryText({
        source: "deterministic",
        decision: "consult",
        confidence: 0.42,
        consult: true,
        changedOutcome: false,
      }),
    ).toContain("置信度 0.42");
  });

  it("describes the model decision and whether it changed the outcome", () => {
    expect(jevEntryText({ source: "jev", consult: true, changedOutcome: true, confidence: 0.9 })).toContain(
      "比规则更早",
    );
    expect(jevEntryText({ source: "jev", consult: false, changedOutcome: true })).toContain("跳过了顾问");
    expect(jevEntryText({ source: "jev", consult: false, changedOutcome: false })).toContain("与规则一致");
  });
});

describe("jevProbeSummary and role-edit preservation", () => {
  it("describes a failed probe", () => {
    expect(
      jevProbeSummary({ ok: false, latencyMs: 12, error: "timeout" } as never),
    ).toBe("连接失败（12 ms）：timeout");
  });

  it("describes a successful probe with and without a reason", () => {
    const base = {
      ok: true,
      latencyMs: 30,
      decision: { decision: "consult", confidence: 0.87 },
    };
    expect(jevProbeSummary(base as never)).toContain("升级给顾问");
    expect(
      jevProbeSummary({ ...base, decision: { ...base.decision, reason: "低置信" } } as never),
    ).toContain("低置信");
    expect(
      jevProbeSummary({
        ok: true,
        latencyMs: 30,
        decision: { decision: "retry", confidence: 0.12 },
      } as never),
    ).toContain("直接重试");
  });

  it("only preserves edits on a quiet, visible refresh", () => {
    expect(shouldPreserveRoleEdits(true, { quiet: true, keepVisible: true })).toBe(true);
    expect(shouldPreserveRoleEdits(true, { quiet: true })).toBe(false);
    expect(shouldPreserveRoleEdits(true, undefined)).toBe(false);
    expect(shouldPreserveRoleEdits(false, { quiet: true, keepVisible: true })).toBe(false);
  });
});

describe("formatExperienceTag", () => {
  it("maps known tags and parameterised ones", () => {
    expect(formatExperienceTag("failure")).toBe("失败");
    expect(formatExperienceTag("control-plane")).toBe("控制面");
    expect(formatExperienceTag("strategy:balanced")).toContain("策略:");
    expect(formatExperienceTag("topology:sequential")).toContain("拓扑:");
    expect(formatExperienceTag("unknown")).toBe("unknown");
  });
});
