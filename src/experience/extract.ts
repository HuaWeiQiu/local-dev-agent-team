import type { RunState } from "../state/types.js";
import type { ExtractExperienceInput } from "./catalog.js";

const terminalStatuses = new Set(["completed", "blocked", "cancelled", "interrupted"]);

const statusZh: Record<string, string> = {
  completed: "已完成",
  blocked: "已阻塞",
  cancelled: "已取消",
  interrupted: "已中断",
};

const topologyZh: Record<string, string> = {
  "parallel-dag": "依赖并行",
  sequential: "顺序执行",
};

/**
 * Deterministic candidate extraction from a finished run.
 * Operator-facing Chinese only — no raw English stack dumps.
 */
export function extractCandidatesFromRun(
  state: RunState,
  projectName: string,
): ExtractExperienceInput[] {
  if (!terminalStatuses.has(state.status)) return [];

  const candidates: ExtractExperienceInput[] = [];
  const strategyName = state.strategy?.name ?? "默认";
  const topology = state.strategy?.topology?.mode ?? "parallel-dag";
  const topologyLabel = topologyZh[topology] ?? topology;
  const statusLabel = statusZh[state.status] ?? state.status;
  const taskTotal = state.tasks.length;
  const passed =
    state.tasks.filter((task) => task.status === "passed" || task.status === "merged").length;
  const reworked = state.tasks.filter((task) => task.attempts > 1).length;
  const isEval = state.purpose === "evolution-evaluation";

  // Evaluation runs: only keep portable success patterns (no raw eval goals as failure dumps).
  if (isEval) {
    if (state.status === "completed" && taskTotal > 0) {
      candidates.push({
        project: projectName,
        summary: `评测通过：策略「${strategyName}」（${topologyLabel}）完成 ${taskTotal} 个任务，通过 ${passed} 个。`,
        conditions: [
          "状态：已完成",
          "场景：评测",
          `策略：${strategyName}`,
          `拓扑：${topologyLabel}`,
        ],
        sourceRunId: state.id,
        sensitivity: "low",
        tags: ["成功", "评测", `策略:${strategyName}`, `拓扑:${topologyLabel}`],
        portability: "cross-project",
        reason: "从评测成功运行抽取策略模式",
      });
    }
    return candidates;
  }

  if (state.error?.trim()) {
    const portable = portableFailureLesson(state.error);
    if (portable) {
      candidates.push({
        project: projectName,
        summary: portable.summary,
        conditions: [
          `状态：${statusLabel}`,
          `策略：${strategyName}`,
          `拓扑：${topologyLabel}`,
          ...portable.conditions,
        ],
        sourceRunId: state.id,
        sensitivity: "low",
        tags: ["失败", portable.tag, `策略:${strategyName}`],
        portability: "cross-project",
        reason: "从终态运行抽取可迁移失败经验",
      });
    } else {
      candidates.push({
        project: projectName,
        summary: `运行${statusLabel}：${humanizeErrorBrief(state.error)}`,
        conditions: [
          `状态：${statusLabel}`,
          `策略：${strategyName}`,
          `拓扑：${topologyLabel}`,
        ],
        sourceRunId: state.id,
        sensitivity: "medium",
        tags: ["失败", `策略:${strategyName}`],
        portability: "project-bound",
        reason: "从终态运行抽取项目内失败摘要",
      });
    }
  }

  if (state.status === "completed" && taskTotal > 0) {
    candidates.push({
      project: projectName,
      summary: `策略「${strategyName}」（${topologyLabel}）完成 ${taskTotal} 个任务，通过 ${passed} 个，可作同类目标参考。`,
      conditions: [
        "状态：已完成",
        `策略：${strategyName}`,
        `拓扑：${topologyLabel}`,
        `任务数≥${Math.min(taskTotal, 8)}`,
      ],
      sourceRunId: state.id,
      sensitivity: "low",
      tags: ["成功", `策略:${strategyName}`, `拓扑:${topologyLabel}`],
      portability: "cross-project",
      reason: "从成功运行抽取策略模式",
    });
  }

  if (reworked >= 2) {
    candidates.push({
      project: projectName,
      summary: `本轮有 ${reworked} 个任务返工；拆任务时应收紧路径归属与验收命令，并降低并行冲突。`,
      conditions: [
        "返工任务≥2",
        `策略：${strategyName}`,
        `拓扑：${topologyLabel}`,
      ],
      sourceRunId: state.id,
      sensitivity: "low",
      tags: ["返工", `策略:${strategyName}`],
      portability: "cross-project",
      reason: "从高返工运行抽取拆分建议",
    });
  }

  if (state.status === "blocked" && taskTotal === 0 && !state.error) {
    candidates.push({
      project: projectName,
      summary: "任务规划前即阻塞；检查总控/架构模型配置与目标是否可执行。",
      conditions: ["状态：已阻塞", "任务数：0", `策略：${strategyName}`],
      sourceRunId: state.id,
      sensitivity: "low",
      tags: ["规划", "失败"],
      portability: "cross-project",
      reason: "从规划前阻塞抽取检查项",
    });
  }

  return candidates;
}

function portableFailureLesson(
  error: string,
): { summary: string; conditions: string[]; tag: string } | undefined {
  const text = error.replace(/\s+/g, " ").trim();
  if (/ENOENT/i.test(text) && /codex/i.test(text)) {
    return {
      summary:
        "桌面启动时 PATH 可能不含 Homebrew，找不到 Codex；应注入 /opt/homebrew/bin 与 /usr/local/bin。",
      conditions: ["错误：找不到 Codex", "场景：桌面/GUI"],
      tag: "工具",
    };
  }
  if (/ENOENT/i.test(text) && /grok/i.test(text)) {
    return {
      summary: "找不到 Grok 命令时不要当任务质量失败；先确认已安装并在 PATH 中。",
      conditions: ["错误：找不到 Grok"],
      tag: "工具",
    };
  }
  if (/MODEL_QUOTA_EXHAUSTED|quota|额度/i.test(text)) {
    return {
      summary: "模型额度用尽时应换账号/额度并暂停自动演进，不要记成策略变差。",
      conditions: ["错误：模型额度"],
      tag: "模型",
    };
  }
  if (/MODEL_RATE_LIMITED|rate.?limit|429/i.test(text)) {
    return {
      summary: "模型被限流时应退避重试并启用备用配置，避免并行打满同一账号。",
      conditions: ["错误：模型限流"],
      tag: "模型",
    };
  }
  if (/MODEL_AUTH_FAILED|unauthorized|401|authentication/i.test(text)) {
    return {
      summary: "模型认证失败时先修登录状态，不要继续空转自动演进轮次。",
      conditions: ["错误：模型认证"],
      tag: "模型",
    };
  }
  if (/circuit open|MODEL_PROCESS_ERROR/i.test(text) && /circuit/i.test(text)) {
    return {
      summary: "模型熔断冷却中应等待恢复后再试，不要立刻新建运行刷失败。",
      conditions: ["错误：熔断冷却"],
      tag: "模型",
    };
  }
  if (/Control service is shutting down|owning control service stopped/i.test(text)) {
    return {
      summary: "控制服务关闭会中断运行；有检查点请「从检查点继续」，别当任务本身有问题。",
      conditions: ["错误：控制服务关闭"],
      tag: "控制面",
    };
  }
  if (/All profiles failed for role/i.test(text)) {
    const role = text.match(/role '([^']+)'/i)?.[1];
    const roleZh = roleLabel(role);
    return {
      summary: roleZh
        ? `角色「${roleZh}」全部模型配置失败：检查允许列表、备用配置与登录状态。`
        : "角色全部模型配置失败：检查允许列表、备用配置与登录状态。",
      conditions: ["错误：角色配置链失败", ...(roleZh ? [`角色：${roleZh}`] : [])],
      tag: "模型",
    };
  }
  if (/not valid JSON|invalid structured/i.test(text)) {
    return {
      summary: "模型返回格式无效时，收紧输出要求或换推理更强的配置，并减少并行干扰。",
      conditions: ["错误：结构化输出无效"],
      tag: "规划",
    };
  }
  return undefined;
}

function humanizeErrorBrief(error: string): string {
  const text = error.replace(/\s+/g, " ").trim();
  if (/ENOENT/i.test(text) && /codex/i.test(text)) return "找不到 Codex 命令";
  if (/ENOENT/i.test(text) && /grok/i.test(text)) return "找不到 Grok 命令";
  if (/MODEL_QUOTA|额度|quota/i.test(text)) return "模型额度用尽";
  if (/rate.?limit|429/i.test(text)) return "模型被限流";
  if (/401|unauthorized|auth/i.test(text)) return "模型认证失败";
  if (/circuit/i.test(text)) return "模型熔断冷却中";
  if (/shutting down|control service stopped/i.test(text)) return "控制服务已关闭";
  // Avoid dumping English stacks into the catalog
  const first = text.split(/[.\n]/)[0]?.trim() ?? text;
  if (/[A-Za-z]{4,}/.test(first) && !/[\u4e00-\u9fff]/.test(first)) {
    return "执行失败（详见运行日志）";
  }
  return truncate(first, 80);
}

function roleLabel(role: string | undefined): string | undefined {
  if (!role) return undefined;
  const map: Record<string, string> = {
    orchestrator: "总控",
    architect: "架构",
    worker: "执行",
    reviewer: "审查",
    tester: "测试",
  };
  return map[role] ?? role;
}

function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
