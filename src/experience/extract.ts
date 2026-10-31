import type { RunState } from "../state/types.js";
import type { ExtractExperienceInput } from "./catalog.js";

const terminalStatuses = new Set([
  "completed",
  "blocked",
  "cancelled",
  "interrupted",
  // A normal run stops here after the final human approval; without it the
  // library could only ever learn from failures.
  "ready-to-merge",
]);

const statusZh: Record<string, string> = {
  completed: "已完成",
  blocked: "已阻塞",
  cancelled: "已取消",
  interrupted: "已中断",
  "ready-to-merge": "已就绪待合并",
};

const topologyZh: Record<string, string> = {
  "parallel-dag": "依赖并行",
  sequential: "顺序执行",
};

interface CandidateContext {
  state: RunState;
  projectName: string;
  strategyName: string;
  topologyLabel: string;
  statusLabel: string;
  taskTotal: number;
  passed: number;
  reworked: number;
  /** Union of owned paths, capped: retrieval cites entries against repo paths. */
  paths: string[];
}

/**
 * Deterministic candidate extraction from a finished run.
 * Operator-facing Chinese only — no raw English stack dumps.
 */
export function extractCandidatesFromRun(
  state: RunState,
  projectName: string,
): ExtractExperienceInput[] {
  if (!terminalStatuses.has(state.status)) return [];
  const context = buildContext(state, projectName);
  if (context.state.purpose === "evolution-evaluation") {
    return evaluationCandidates(context);
  }
  return [
    ...failureCandidates(context),
    ...successCandidate(context),
    ...reworkCandidate(context),
    ...emptyPlanCandidate(context),
  ];
}

function buildContext(state: RunState, projectName: string): CandidateContext {
  const strategyName = state.strategy?.name ?? "默认";
  const topology = state.strategy?.topology?.mode ?? "parallel-dag";
  return {
    state,
    projectName,
    strategyName,
    topologyLabel: topologyZh[topology] ?? topology,
    statusLabel: statusZh[state.status] ?? state.status,
    ...countTasks(state),
    paths: touchedPaths(state),
  };
}

function countTasks(state: RunState): {
  taskTotal: number;
  passed: number;
  reworked: number;
} {
  return {
    taskTotal: state.tasks.length,
    passed: state.tasks.filter(
      (task) => task.status === "passed" || task.status === "merged",
    ).length,
    reworked: state.tasks.filter((task) => task.attempts > 1).length,
  };
}

/** Union of the owned paths across tasks, ordered and deduplicated. */
function touchedPaths(state: RunState): string[] {
  const seen = new Set<string>();
  for (const task of state.tasks) {
    for (const owned of task.task.ownedPaths ?? []) {
      if (owned.trim()) seen.add(owned.trim());
    }
  }
  return [...seen].slice(0, 5);
}

function pathConditions(context: CandidateContext): string[] {
  if (context.paths.length === 0) return [];
  return [truncate(`涉及路径：${context.paths.join("、")}`, 500)];
}

function evaluationCandidates(context: CandidateContext): ExtractExperienceInput[] {
  if (context.state.status !== "completed" || context.taskTotal === 0) return [];
  return [
    {
      project: context.projectName,
      summary: `评测通过：策略「${context.strategyName}」（${context.topologyLabel}）完成 ${context.taskTotal} 个任务，通过 ${context.passed} 个。`,
      conditions: [
        "状态：已完成",
        "场景：评测",
        `策略：${context.strategyName}`,
        `拓扑：${context.topologyLabel}`,
        ...pathConditions(context),
      ],
      sourceRunId: context.state.id,
      sensitivity: "low",
      tags: ["成功", "评测", `策略:${context.strategyName}`, `拓扑:${context.topologyLabel}`],
      portability: "cross-project",
      reason: "从评测成功运行抽取策略模式",
    },
  ];
}

function failureCandidates(context: CandidateContext): ExtractExperienceInput[] {
  const error = context.state.error?.trim();
  if (!error) return [];
  const baseConditions = [
    `状态：${context.statusLabel}`,
    `策略：${context.strategyName}`,
    `拓扑：${context.topologyLabel}`,
  ];
  const portable = portableFailureLesson(error);
  if (!portable) {
    return [
      {
        project: context.projectName,
        summary: `运行${context.statusLabel}：${humanizeErrorBrief(error)}`,
        conditions: [...baseConditions, ...pathConditions(context)],
        sourceRunId: context.state.id,
        sensitivity: "medium",
        tags: ["失败", `策略:${context.strategyName}`],
        portability: "project-bound",
        reason: "从终态运行抽取项目内失败摘要",
      },
    ];
  }
  return [
    {
      project: context.projectName,
      summary: portable.summary,
      conditions: [...baseConditions, ...portable.conditions, ...pathConditions(context)],
      sourceRunId: context.state.id,
      sensitivity: "low",
      tags: ["失败", portable.tag, `策略:${context.strategyName}`],
      portability: "cross-project",
      reason: "从终态运行抽取可迁移失败经验",
    },
  ];
}

function successCandidate(context: CandidateContext): ExtractExperienceInput[] {
  const status = context.state.status;
  if ((status !== "completed" && status !== "ready-to-merge") || context.taskTotal === 0) {
    return [];
  }
  return [
    {
      project: context.projectName,
      summary: `策略「${context.strategyName}」（${context.topologyLabel}）完成 ${context.taskTotal} 个任务，通过 ${context.passed} 个，可作同类目标参考。`,
      conditions: [
        `状态：${context.statusLabel}`,
        `策略：${context.strategyName}`,
        `拓扑：${context.topologyLabel}`,
        `任务数≥${Math.min(context.taskTotal, 8)}`,
        ...pathConditions(context),
      ],
      sourceRunId: context.state.id,
      sensitivity: "low",
      tags: ["成功", `策略:${context.strategyName}`, `拓扑:${context.topologyLabel}`],
      portability: "cross-project",
      reason: "从成功运行抽取策略模式",
    },
  ];
}

function reworkCandidate(context: CandidateContext): ExtractExperienceInput[] {
  if (context.reworked < 2) return [];
  return [
    {
      project: context.projectName,
      summary: `本轮有 ${context.reworked} 个任务返工；拆任务时应收紧路径归属与验收命令，并降低并行冲突。`,
      conditions: [
        "返工任务≥2",
        `策略：${context.strategyName}`,
        `拓扑：${context.topologyLabel}`,
        ...pathConditions(context),
      ],
      sourceRunId: context.state.id,
      sensitivity: "low",
      tags: ["返工", `策略:${context.strategyName}`],
      portability: "cross-project",
      reason: "从高返工运行抽取拆分建议",
    },
  ];
}

function emptyPlanCandidate(context: CandidateContext): ExtractExperienceInput[] {
  if (context.state.status !== "blocked" || context.taskTotal !== 0 || context.state.error) {
    return [];
  }
  return [
    {
      project: context.projectName,
      summary: "任务规划前即阻塞；检查总控/架构模型配置与目标是否可执行。",
      conditions: ["状态：已阻塞", "任务数：0", `策略：${context.strategyName}`],
      sourceRunId: context.state.id,
      sensitivity: "low",
      tags: ["规划", "失败"],
      portability: "cross-project",
      reason: "从规划前阻塞抽取检查项",
    },
  ];
}

interface PortableRule {
  match: (text: string) => boolean;
  tag: string;
  lesson: (text: string) => { summary: string; conditions: string[] };
}

const PORTABLE_RULES: PortableRule[] = [
  {
    match: (text) => /ENOENT/i.test(text) && /codex/i.test(text),
    tag: "工具",
    lesson: () => ({
      summary:
        "桌面启动时 PATH 可能不含 Homebrew，找不到 Codex；应注入 /opt/homebrew/bin 与 /usr/local/bin。",
      conditions: ["错误：找不到 Codex", "场景：桌面/GUI"],
    }),
  },
  {
    match: (text) => /ENOENT/i.test(text) && /grok/i.test(text),
    tag: "工具",
    lesson: () => ({
      summary: "找不到 Grok 命令时不要当任务质量失败；先确认已安装并在 PATH 中。",
      conditions: ["错误：找不到 Grok"],
    }),
  },
  {
    match: (text) => /MODEL_QUOTA_EXHAUSTED|quota|额度/i.test(text),
    tag: "模型",
    lesson: () => ({
      summary: "模型额度用尽时应换账号/额度并暂停自动演进，不要记成策略变差。",
      conditions: ["错误：模型额度"],
    }),
  },
  {
    match: (text) => /MODEL_RATE_LIMITED|rate.?limit|429/i.test(text),
    tag: "模型",
    lesson: () => ({
      summary: "模型被限流时应退避重试并启用备用配置，避免并行打满同一账号。",
      conditions: ["错误：模型限流"],
    }),
  },
  {
    match: (text) => /MODEL_AUTH_FAILED|unauthorized|401|authentication/i.test(text),
    tag: "模型",
    lesson: () => ({
      summary: "模型认证失败时先修登录状态，不要继续空转自动演进轮次。",
      conditions: ["错误：模型认证"],
    }),
  },
  {
    match: (text) => /circuit/i.test(text),
    tag: "模型",
    lesson: () => ({
      summary: "模型熔断冷却中应等待恢复后再试，不要立刻新建运行刷失败。",
      conditions: ["错误：熔断冷却"],
    }),
  },
  {
    match: (text) => /Control service is shutting down|owning control service stopped/i.test(text),
    tag: "控制面",
    lesson: () => ({
      summary: "控制服务关闭会中断运行；有检查点请「从检查点继续」，别当任务本身有问题。",
      conditions: ["错误：控制服务关闭"],
    }),
  },
  {
    match: (text) => /All profiles failed for role/i.test(text),
    tag: "模型",
    lesson: (text) => {
      const roleZh = roleLabel(text.match(/role '([^']+)'/i)?.[1]);
      return {
        summary: roleZh
          ? `角色「${roleZh}」全部模型配置失败：检查允许列表、备用配置与登录状态。`
          : "角色全部模型配置失败：检查允许列表、备用配置与登录状态。",
        conditions: ["错误：角色配置链失败", ...(roleZh ? [`角色：${roleZh}`] : [])],
      };
    },
  },
  {
    match: (text) => /not valid JSON|invalid structured/i.test(text),
    tag: "规划",
    lesson: () => ({
      summary: "模型返回格式无效时，收紧输出要求或换推理更强的配置，并减少并行干扰。",
      conditions: ["错误：结构化输出无效"],
    }),
  },
];

function portableFailureLesson(
  error: string,
): { summary: string; conditions: string[]; tag: string } | undefined {
  const text = error.replace(/\s+/g, " ").trim();
  const rule = PORTABLE_RULES.find((candidate) => candidate.match(text));
  if (!rule) return undefined;
  return { ...rule.lesson(text), tag: rule.tag };
}

const ERROR_LABELS: Array<{ match: (text: string) => boolean; label: string }> = [
  { match: (text) => /ENOENT/i.test(text) && /codex/i.test(text), label: "找不到 Codex 命令" },
  { match: (text) => /ENOENT/i.test(text) && /grok/i.test(text), label: "找不到 Grok 命令" },
  { match: (text) => /MODEL_QUOTA|额度|quota/i.test(text), label: "模型额度用尽" },
  { match: (text) => /rate.?limit|429/i.test(text), label: "模型被限流" },
  { match: (text) => /401|unauthorized|auth/i.test(text), label: "模型认证失败" },
  { match: (text) => /circuit/i.test(text), label: "模型熔断冷却中" },
  { match: (text) => /shutting down|control service stopped/i.test(text), label: "控制服务已关闭" },
];

function humanizeErrorBrief(error: string): string {
  const text = error.replace(/\s+/g, " ").trim();
  const known = ERROR_LABELS.find((candidate) => candidate.match(text));
  if (known) return known.label;
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
