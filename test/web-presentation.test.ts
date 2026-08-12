import { describe, expect, it } from "vitest";
import { buildTaskGraph } from "../web/src/graph.js";
import {
  agentRoleLabel,
  canvasEmptyCopy,
  formatExperienceCondition,
  formatExperienceTag,
  humanizeFailure,
  morphologySummary,
  preferredMonitorPanel,
  profileDisplayName,
  runListSubtitle,
  runStatusLabel,
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
    expect(canvasEmptyCopy({ status: "orchestrating", tasks: [] }).title).toBe("正在规划任务");
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
    expect(canvasEmptyCopy({ status: "orchestrating", tasks: [] }).title).toBe("正在规划任务");
    expect(formatExperienceCondition("status=blocked")).toBe("状态：已阻塞");
    expect(formatExperienceCondition("topology=parallel-dag")).toBe("拓扑：依赖并行");
    expect(formatExperienceTag("failure")).toBe("失败");
    expect(formatExperienceTag("tooling")).toBe("工具");
    expect(preferredMonitorPanel({ status: "orchestrating", tasks: [] })).toBe("activity");
    expect(preferredMonitorPanel({ status: "blocked", tasks: [], error: "x" })).toBe("activity");
    expect(preferredMonitorPanel({ status: "implementing", tasks: [{}] })).toBe("graph");
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
