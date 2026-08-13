import { describe, expect, it } from "vitest";
import { ApiError } from "../web/src/api.js";
import { buildTaskGraph } from "../web/src/graph.js";
import { assessPlanCompleteness, namedDeliverablesInGoal } from "../web/src/plan-completeness.js";
import {
  agentRoleLabel,
  canvasEmptyCopy,
  formatExperienceCondition,
  formatExperienceTag,
  humanizeFailure,
  morphologySummary,
  orderedRoles,
  preferredMonitorPanel,
  profileDisplayName,
  runActionErrorMessage,
  runListSubtitle,
  runStatusLabel,
  shouldPreserveRoleEdits,
  statusTone,
  strategyDisplayName,
  summarizeGoal,
  topologyDisplayName,
} from "../web/src/presentation.js";
import type { TaskRunState } from "../web/src/types.js";

// buildTaskGraph reads flow palette colors from page CSS tokens; vitest runs in a
// node environment without a DOM, so stub just enough for flowPalette() to fall
// back to its default colors.
const globals = globalThis as { document?: unknown; getComputedStyle?: unknown };
globals.document ??= { documentElement: {} };
globals.getComputedStyle ??= () => ({ getPropertyValue: () => "" });

describe("web workbench projections", () => {
  it("lays a task DAG into dependency ranks", () => {
    const tasks = [fixtureTask("api", []), fixtureTask("ui", ["api"]), fixtureTask("docs", ["api"])];
    const graph = buildTaskGraph(tasks);
    const api = graph.nodes.find((node) => node.id === "api")!;
    const ui = graph.nodes.find((node) => node.id === "ui")!;
    const docs = graph.nodes.find((node) => node.id === "docs")!;

    expect(ui.position.x).toBeGreaterThan(api.position.x);
    expect(docs.position.x).toBe(ui.position.x);
    expect(docs.position.y).not.toBe(ui.position.y);
    expect(graph.edges).toHaveLength(2);
  });

  it("maps execution states to stable labels and semantic tones", () => {
    expect(runStatusLabel("reviewing-testing")).toBe("审查测试");
    expect(runStatusLabel("exploring")).toBe("代码探索");
    expect(runStatusLabel("implementing")).toBe("执行波次");
    expect(statusTone("blocked")).toBe("danger");
    expect(statusTone("merged")).toBe("success");
    expect(morphologySummary({
      maxParallel: 3,
      taskMorphology: {
        explore: { enabled: true },
        implement: { swarm: { maxConcurrency: 2 } },
      },
    })).toContain("探索开");
    expect(morphologySummary({
      maxParallel: 3,
      taskMorphology: {
        explore: { enabled: true },
        implement: { swarm: { maxConcurrency: 2 } },
      },
    })).toContain("Swarm ≤2");
  });

  it("maps strategy, topology and role ids to Chinese operator labels", () => {
    expect(strategyDisplayName("balanced")).toBe("均衡");
    expect(strategyDisplayName("strict")).toBe("严格");
    expect(strategyDisplayName("auto-evolved")).toBe("自动演进");
    expect(strategyDisplayName("my-custom-blueprint")).toBe("my-custom-blueprint");
    expect(topologyDisplayName("parallel-dag")).toBe("依赖并行");
    expect(topologyDisplayName("sequential")).toBe("顺序执行");
    expect(agentRoleLabel("orchestrator")).toBe("总控");
    expect(agentRoleLabel("researcher")).toBe("技术研究员");
    expect(agentRoleLabel("worker")).toBe("执行");
    expect(agentRoleLabel("reviewer")).toBe("审查");
    expect(profileDisplayName("codex-orchestrator")).toBe("Codex · 总控");
    expect(profileDisplayName("grok-worker-fast")).toBe("Grok · 执行（轻量）");
    expect(profileDisplayName("custom-x", { adapter: "codex", model: "gpt-5.6-sol" })).toContain("Codex");
    expect(
      runListSubtitle({
        status: "implementing",
        taskCounts: { working: 1, merged: 1 },
        strategy: "balanced",
      }),
    ).toContain("均衡");
    expect(formatExperienceCondition("strategy=strict")).toBe("策略：严格");
    expect(formatExperienceTag("strategy:auto-evolved")).toBe("策略:自动演进");
  });

  it("shortens goals and humanizes operator-facing failures", () => {
    expect(summarizeGoal("第一行目标\n第二行补充", 20)).toBe("第一行目标");
    expect(humanizeFailure("spawn codex ENOENT")).toContain("找不到 Codex");
    expect(humanizeFailure("Control service is shutting down")).toContain("检查点");
    expect(
      runListSubtitle({
        status: "blocked",
        error: "spawn codex ENOENT",
        taskCounts: {},
        strategy: "default",
      }),
    ).toContain("找不到 Codex");
    expect(canvasEmptyCopy({ status: "blocked", error: "boom", tasks: [] }).title).toBe("运行已阻塞");
    expect(canvasEmptyCopy({ status: "orchestrating", tasks: [] }).title).toBe("架构正在拆任务图");
    expect(formatExperienceCondition("status=blocked")).toBe("状态：已阻塞");
    expect(formatExperienceCondition("topology=parallel-dag")).toBe("拓扑：依赖并行");
    expect(formatExperienceTag("failure")).toBe("失败");
    expect(formatExperienceTag("tooling")).toBe("工具");
    expect(preferredMonitorPanel({ status: "orchestrating", tasks: [] })).toBe("activity");
    expect(preferredMonitorPanel({ status: "blocked", tasks: [], error: "x" })).toBe("activity");
    expect(preferredMonitorPanel({ status: "implementing", tasks: [{}] })).toBe("graph");
  });

  it("shortens goals and humanizes operator-facing failures", () => {
    expect(summarizeGoal("第一行目标\n第二行补充", 20)).toBe("第一行目标");
    expect(humanizeFailure("spawn codex ENOENT")).toContain("找不到 Codex");
    expect(humanizeFailure("Control service is shutting down")).toContain("检查点");
    expect(
      runListSubtitle({
        status: "blocked",
        error: "spawn codex ENOENT",
        taskCounts: {},
        strategy: "default",
      }),
    ).toContain("找不到 Codex");
    expect(canvasEmptyCopy({ status: "blocked", error: "boom", tasks: [] }).title).toBe("运行已阻塞");
    expect(canvasEmptyCopy({ status: "orchestrating", tasks: [] }).title).toBe("架构正在拆任务图");
    expect(formatExperienceCondition("status=blocked")).toBe("状态：已阻塞");
    expect(formatExperienceCondition("topology=parallel-dag")).toBe("拓扑：依赖并行");
    expect(formatExperienceTag("failure")).toBe("失败");
    expect(formatExperienceTag("tooling")).toBe("工具");
    expect(preferredMonitorPanel({ status: "orchestrating", tasks: [] })).toBe("activity");
    expect(preferredMonitorPanel({ status: "blocked", tasks: [], error: "x" })).toBe("activity");
    expect(preferredMonitorPanel({ status: "implementing", tasks: [{}] })).toBe("graph");
  });

  it("keeps known roles in canonical order and appends custom config roles", () => {
    expect(orderedRoles(["tester", "orchestrator", "worker"])).toEqual(["orchestrator", "worker", "tester"]);
    expect(orderedRoles(["security-auditor", "worker", "orchestrator"])).toEqual([
      "orchestrator",
      "worker",
      "security-auditor",
    ]);
    expect(orderedRoles(["custom-b", "custom-a"])).toEqual(["custom-a", "custom-b"]);
    expect(agentRoleLabel("security-auditor")).toBe("security-auditor");
  });

  it("keeps custom strategy names raw instead of mistranslating them", () => {
    expect(strategyDisplayName("balanced")).toBe("均衡");
    expect(strategyDisplayName("my-custom-blueprint")).toBe("my-custom-blueprint");
  });

  it("preserves unsaved role edits only on quiet keep-visible auto refresh", () => {
    // 脏 + 自动刷新（轮询 / focus 的 quiet+keepVisible load）→ 保留编辑
    expect(shouldPreserveRoleEdits(true, { quiet: true, keepVisible: true })).toBe(true);
    // 未脏 → 照常覆盖
    expect(shouldPreserveRoleEdits(false, { quiet: true, keepVisible: true })).toBe(false);
    // 首次加载 / 手动触发路径不保留：无 opts、只 quiet、只 keepVisible、keepVisible=false
    expect(shouldPreserveRoleEdits(true, undefined)).toBe(false);
    expect(shouldPreserveRoleEdits(true, {})).toBe(false);
    expect(shouldPreserveRoleEdits(true, { quiet: true })).toBe(false);
    expect(shouldPreserveRoleEdits(true, { keepVisible: true })).toBe(false);
    expect(shouldPreserveRoleEdits(true, { quiet: true, keepVisible: false })).toBe(false);
  });

  it("maps run action errors to actionable Chinese guidance", () => {
    expect(runActionErrorMessage(new ApiError(404, "Run not found"))).toContain("刷新列表后重试");
    expect(runActionErrorMessage(new ApiError(401, "Desktop session is required", "SESSION_REQUIRED"))).toContain("控制会话");
    expect(runActionErrorMessage(new ApiError(403, "Forbidden", "ORIGIN_DENIED"))).toContain("来源");
    expect(runActionErrorMessage(new ApiError(409, "Run is not active in this control service"))).toContain("刷新列表后重试");
    expect(
      runActionErrorMessage(new ApiError(409, "Run 'r1' still has an active child run", "RUN_STATE_CONFLICT")),
    ).toContain("后续运行");
    expect(
      runActionErrorMessage(new ApiError(409, "Run 'r1' is still referenced as a parent of another retained run")),
    ).toContain("后续运行");
    expect(runActionErrorMessage(new Error("Run 'r1' cannot be retried from status 'completed'"))).toContain("不允许重试");
    expect(runActionErrorMessage(new Error("Run 'r1' has no recoverable task-boundary checkpoint"))).toContain("重试为新运行");
    expect(runActionErrorMessage(new Error("Approval request 'a1' expired at 2026-01-01"))).toContain("审批已过期");
    expect(runActionErrorMessage(new Error("Cleanup preview is missing or expired; create a new preview"))).toContain("清理预览");
    expect(runActionErrorMessage(new Error("something entirely unexpected"))).toBe("something entirely unexpected");
  });

  it("projects plan completeness and named deliverables for the canvas", () => {
    expect(namedDeliverablesInGoal("Implement T1-T4")).toEqual(["T1", "T2", "T3", "T4"]);
    expect(namedDeliverablesInGoal("根据交接文档完成任务")).toEqual([]);
    expect(humanizeFailure("Plan completeness rejected: 缺 T2 / 缺 T3")).toContain("计划不完备");
    expect(humanizeFailure("Integration quality commands failed: tsc: command not found")).toContain("集成质量门失败");
    const report = assessPlanCompleteness(
      {
        tasks: [{
          id: "inspect-handoff",
          title: "Inspect handover",
          description: "read-only",
          dependsOn: [],
          ownedPaths: ["docs/HANDOFF.md"],
          acceptanceCommands: [],
          profile: null,
        }],
      },
      "Implement T1-T4",
    );
    expect(report.status).toBe("rejected");
    expect(report.issues.some((issue) => issue.includes("缺 T1"))).toBe(true);
  });
});

function fixtureTask(id: string, dependsOn: string[]): TaskRunState {
  return {
    task: {
      id,
      title: id,
      description: id,
      dependsOn,
      ownedPaths: [`src/${id}.ts`],
      acceptanceCommands: [],
      profile: null,
    },
    status: "pending",
    attempts: 0,
  };
}
