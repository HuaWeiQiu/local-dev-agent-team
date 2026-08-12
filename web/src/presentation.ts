import { ApiError } from "./api";
import type { RunStatus, TaskStatus } from "./types";

const runLabels: Record<RunStatus, string> = {
  created: "已创建",
  orchestrating: "目标分析",
  exploring: "代码探索",
  architecting: "任务规划",
  planned: "已规划",
  implementing: "执行波次",
  "reviewing-testing": "审查测试",
  reworking: "返工中",
  integrating: "集成中",
  "final-checks": "最终检查",
  "awaiting-human": "等待确认",
  publishing: "发布中",
  "waiting-ci": "等待 CI",
  "ci-failed": "CI 失败",
  repairing: "修复中",
  "ready-to-merge": "可合并",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "已中断",
  blocked: "已阻塞",
};

const taskLabels: Record<TaskStatus, string> = {
  pending: "等待",
  working: "执行",
  reworking: "返工",
  passed: "通过",
  merged: "已合并",
  blocked: "阻塞",
};

export function runStatusLabel(status: RunStatus | string): string {
  return runLabels[status as RunStatus] ?? status;
}

export function taskStatusLabel(status: TaskStatus): string {
  return taskLabels[status];
}

/** Built-in strategy ids → Chinese UI labels. Custom blueprint names stay as-is. */
const strategyLabels: Record<string, string> = {
  balanced: "均衡",
  strict: "严格",
  sequential: "顺序",
  legacy: "兼容默认",
  default: "默认",
  "auto-evolved": "自动演进",
  "mock-slice": "模拟切片",
};

/** Strategy id for API/config; Chinese label for operators. */
export function strategyDisplayName(name: string | undefined | null): string {
  if (!name?.trim()) return "未指定";
  return strategyLabels[name] ?? name;
}

/** Topology mode ids → Chinese UI labels. */
export function topologyDisplayName(mode: string | undefined | null): string {
  if (!mode) return "未指定";
  if (mode === "parallel-dag") return "依赖并行";
  if (mode === "sequential") return "顺序执行";
  return mode;
}

const roleLabels: Record<string, string> = {
  orchestrator: "总控",
  architect: "架构",
  researcher: "技术研究员",
  worker: "执行",
  reviewer: "审查",
  tester: "测试",
  "orchestrator-final": "最终判定",
};

/** Canonical display order for built-in roles; custom roles append after (sorted). */
const KNOWN_ROLE_ORDER = [
  "orchestrator",
  "architect",
  "researcher",
  "worker",
  "reviewer",
  "tester",
] as const;

/** Role order for pickers: known roles first in canonical order, custom config roles appended. */
export function orderedRoles(available: Iterable<string>): string[] {
  const set = new Set(available);
  const known = KNOWN_ROLE_ORDER.filter((role) => set.has(role));
  const custom = [...set]
    .filter((role) => !(KNOWN_ROLE_ORDER as readonly string[]).includes(role))
    .sort((left, right) => left.localeCompare(right));
  return [...known, ...custom];
}

/** Role id for config; Chinese label for operators. */
export function agentRoleLabel(role: string | undefined | null): string {
  if (!role?.trim()) return "角色";
  return roleLabels[role] ?? role;
}

/** Built-in profile ids → operator-facing Chinese labels. */
const profileLabels: Record<string, string> = {
  "codex-orchestrator": "Codex · 总控",
  "grok-orchestrator": "Grok · 总控",
  "codex-architect": "Codex · 架构",
  "grok-architect": "Grok · 架构",
  "codex-researcher": "Codex · 技术研究员",
  "grok-researcher": "Grok · 技术研究员",
  "codex-reviewer": "Codex · 审查",
  "grok-reviewer": "Grok · 审查",
  "codex-tester": "Codex · 测试",
  "grok-tester": "Grok · 测试",
  "codex-worker": "Codex · 执行",
  "grok-worker": "Grok · 执行",
  "grok-worker-fast": "Grok · 执行（轻量）",
  "grok-worker-heavy": "Grok · 执行（重任务）",
  "codex-planner": "Codex · 规划",
};

export interface ProfileLabelHint {
  adapter?: string;
  model?: string;
  permission?: string;
  externalTools?: string;
}

/** Profile id for config; Chinese/readable label for operators. */
export function profileDisplayName(
  name: string | undefined | null,
  hint?: ProfileLabelHint,
): string {
  if (!name?.trim()) return "未指定";
  if (profileLabels[name]) return profileLabels[name];
  if (hint?.adapter) {
    const adapter =
      hint.adapter === "codex" ? "Codex"
        : hint.adapter === "grok" ? "Grok"
          : hint.adapter;
    const model = hint.model && hint.model !== "inherit" && hint.model !== "grok"
      ? ` · ${hint.model}`
      : "";
    return `${adapter}${model} · ${name}`;
  }
  return name;
}

export function statusTone(status: RunStatus | TaskStatus): string {
  if (["completed", "ready-to-merge", "awaiting-human", "passed", "merged"].includes(status)) {
    return "success";
  }
  if (["blocked", "ci-failed"].includes(status)) {
    return "danger";
  }
  if (["cancelled", "interrupted"].includes(status)) {
    return "neutral";
  }
  if (["reworking", "reviewing-testing", "final-checks"].includes(status)) {
    return "warning";
  }
  return "active";
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortRunId(runId: string): string {
  return runId.length > 20 ? `${runId.slice(0, 12)}…${runId.slice(-5)}` : runId;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run action / control-service errors → Chinese with actionable guidance.
 * Unrecognized errors fall back to the original message.
 */
export function runActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.code === "SESSION_REQUIRED") {
      return "本地控制会话尚未建立，请从服务启动时输出的地址重新打开应用。";
    }
    if (error.code === "ORIGIN_DENIED") {
      return "当前页面来源与控制服务不一致，请从控制服务地址打开应用。";
    }
    if (error.status === 404) return "目标运行已不存在，请刷新列表后重试。";
    if (error.status === 409) return "运行状态已变化或不由当前服务管理，请刷新列表后重试。";
    if (error.code === "REQUEST_TOO_LARGE") return "请求内容过大，请精简后重试。";
  }
  const text = errorMessage(error);
  if (/Run '.*' was not found/i.test(text)) return "目标运行已不存在，请刷新列表后重试。";
  if (/cannot be retried from status/i.test(text)) return "当前状态不允许重试，请刷新列表确认最新状态。";
  if (/cannot resume from status/i.test(text)) return "当前状态不允许继续，请刷新列表确认最新状态。";
  if (/no recoverable task-boundary checkpoint/i.test(text)) {
    return "没有可恢复的任务边界检查点，请改用「重试为新运行」。";
  }
  if (/is already active/i.test(text)) return "该运行已在执行中，无需重复操作。";
  if (/is still active; cancel it first/i.test(text)) return "运行仍在执行中，请先取消再删除。";
  if (/still has an active child run|still referenced as a parent/i.test(text)) {
    return "该运行仍被其他运行引用，请先处理关联运行。";
  }
  if (/Approval request '.*' was not found/i.test(text)) return "审批请求已不存在，请刷新后重试。";
  if (/already has a response/i.test(text)) return "该审批已处理过，请刷新查看最新状态。";
  if (/expired at/i.test(text)) return "审批已过期，请刷新列表查看运行最新状态。";
  if (/is not the latest request/i.test(text)) return "已有更新的审批请求，请刷新后处理最新一条。";
  if (/cannot accept an approval response/i.test(text)) return "运行正在执行中，暂时不能响应审批。";
  if (/Cleanup preview is missing or expired|changed after preview/i.test(text)) {
    return "清理预览已过期或状态已变化，请重新生成预览后再确认。";
  }
  return text;
}

/** First line of goal as a short human title for lists. */
export function summarizeGoal(goal: string, maxLength = 48): string {
  const first = goal
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? goal.trim();
  const compact = first.replace(/\s+/g, " ");
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

/** Turn raw model/CLI errors into operator-facing Chinese. */
export function humanizeFailure(message: string | undefined | null): string {
  if (!message?.trim()) return "";
  const text = message.replace(/\s+/g, " ").trim();
  if (/ENOENT/i.test(text) && /codex/i.test(text)) {
    return "找不到 Codex 命令（桌面环境 PATH 可能未包含 Homebrew，请重启 App 或检查 codex 安装）";
  }
  if (/ENOENT/i.test(text) && /grok/i.test(text)) {
    return "找不到 Grok 命令（请确认已安装并在 PATH 中）";
  }
  if (/circuit open/i.test(text) || /MODEL_PROCESS_ERROR/i.test(text) && /circuit/i.test(text)) {
    return "模型调用熔断冷却中，请稍后再试";
  }
  if (/MODEL_QUOTA_EXHAUSTED|quota|额度/i.test(text)) {
    return "模型额度已用尽，请更换账号/额度后再试";
  }
  if (/MODEL_RATE_LIMITED|rate.?limit|429/i.test(text)) {
    return "模型请求被限流，请稍后重试";
  }
  if (/MODEL_AUTH_FAILED|unauthorized|401|authentication/i.test(text)) {
    return "模型认证失败，请检查登录状态";
  }
  if (/Control service is shutting down|owning control service stopped/i.test(text)) {
    return "控制服务已关闭，运行被中断；有检查点时可点「从检查点继续」";
  }
  if (/All profiles failed for role/i.test(text)) {
    const role = text.match(/role '([^']+)'/i)?.[1];
    return role
      ? `角色「${agentRoleLabel(role)}」的所有模型配置均失败`
      : "所有备用模型配置均失败";
  }
  if (/not valid JSON|invalid structured/i.test(text)) {
    return "模型返回格式无效，未能解析为结构化结果";
  }
  if (text.length > 120) return `${text.slice(0, 119)}…`;
  return text;
}

export function runListSubtitle(run: {
  status: RunStatus;
  error?: string;
  taskCounts: Record<string, number>;
  strategy: string;
}): string {
  const failure = humanizeFailure(run.error);
  if (failure) return failure;
  const total = Object.values(run.taskCounts).reduce((sum, count) => sum + count, 0);
  const done =
    (run.taskCounts.merged ?? 0) + (run.taskCounts.passed ?? 0);
  if (total === 0) {
    if (run.status === "orchestrating") return "总控正在分析目标";
    if (run.status === "exploring") return "正在只读探索代码库";
    if (run.status === "architecting") return "架构正在拆分任务";
    if (run.status === "blocked") return "在任务规划前失败";
    return "尚未拆分任务";
  }
  return `${done}/${total} 个任务 · ${strategyDisplayName(run.strategy)}`;
}

/** Operator-facing morphology summary for strategy cards. */
export function morphologySummary(definition: {
  maxParallel?: number;
  taskMorphology?: {
    explore?: { enabled?: boolean };
    implement?: { swarm?: { maxConcurrency?: number } };
  };
} | undefined, projectMaxParallel?: number): string {
  if (!definition) return "";
  const exploreOn = definition.taskMorphology?.explore?.enabled === true;
  const maxParallel = definition.maxParallel ?? projectMaxParallel ?? 1;
  const swarm = definition.taskMorphology?.implement?.swarm?.maxConcurrency;
  const swarmLabel = swarm !== undefined
    ? `Swarm ≤${Math.min(swarm, maxParallel)}`
    : `Swarm ≤${maxParallel}`;
  return `${exploreOn ? "探索开" : "探索关"} · ${swarmLabel}`;
}

export function canvasEmptyCopy(run: {
  status: RunStatus;
  error?: string;
  tasks: unknown[];
} | undefined): { title: string; detail: string } {
  if (!run) {
    return { title: "选择一条运行", detail: "从左侧列表点开后，这里显示任务依赖图" };
  }
  const failure = humanizeFailure(run.error);
  if (run.tasks.length === 0) {
    if (run.status === "blocked" || run.status === "cancelled" || run.status === "interrupted") {
      return {
        title: run.status === "interrupted" ? "运行已中断" : run.status === "cancelled" ? "运行已取消" : "运行已阻塞",
        detail: failure || "任务规划尚未完成，因此没有任务图可显示",
      };
    }
    if (
      run.status === "orchestrating"
      || run.status === "exploring"
      || run.status === "architecting"
      || run.status === "created"
    ) {
      return {
        title: "正在规划任务",
        detail: run.status === "exploring"
          ? "只读探索完成后，架构会拆分任务依赖图"
          : "总控与架构完成后，任务依赖图会实时出现在这里",
      };
    }
    return {
      title: "暂无任务节点",
      detail: failure || "当前还没有可展示的任务",
    };
  }
  return { title: "暂无任务节点", detail: "" };
}

export const activeRunStatuses: ReadonlySet<string> = new Set([
  "created",
  "orchestrating",
  "exploring",
  "architecting",
  "planned",
  "implementing",
  "reviewing-testing",
  "reworking",
  "integrating",
  "final-checks",
  "publishing",
  "waiting-ci",
  "repairing",
]);

/**
 * Default main workspace panel when opening a run.
 * Prefer live activity when there is no task graph yet or the run failed early.
 */
export function preferredMonitorPanel(run: {
  status: RunStatus;
  tasks: unknown[];
  error?: string;
} | undefined): "graph" | "activity" {
  if (!run) return "graph";
  if (run.tasks.length > 0) return "graph";
  if (
    run.status === "orchestrating" ||
    run.status === "exploring" ||
    run.status === "architecting" ||
    run.status === "created" ||
    run.status === "blocked" ||
    run.status === "cancelled" ||
    run.status === "interrupted" ||
    Boolean(run.error)
  ) {
    return "activity";
  }
  return "graph";
}

/** Format machine/legacy experience condition keys for Chinese UI. */
export function formatExperienceCondition(condition: string): string {
  const text = condition.trim();
  if (!text) return text;
  if (/[\u4e00-\u9fff]/.test(text) && !/^[a-z_]+=/i.test(text)) return text;

  const map: Record<string, string> = {
    "status=completed": "状态：已完成",
    "status=blocked": "状态：已阻塞",
    "status=cancelled": "状态：已取消",
    "status=interrupted": "状态：已中断",
    "topology=parallel-dag": "拓扑：依赖并行",
    "topology=sequential": "拓扑：顺序执行",
    "tasks=0": "任务数：0",
    "rework-tasks>=2": "返工任务≥2",
    "error=codex-enoent": "错误：找不到 Codex",
    "error=grok-enoent": "错误：找不到 Grok",
    "error=model-quota": "错误：模型额度",
    "error=model-rate-limit": "错误：模型限流",
    "error=model-auth": "错误：模型认证",
    "error=circuit-open": "错误：熔断冷却",
    "error=control-shutdown": "错误：控制服务关闭",
    "error=role-profile-chain": "错误：角色配置链失败",
    "error=invalid-structured-output": "错误：结构化输出无效",
    "platform=desktop-or-gui": "场景：桌面/GUI",
  };
  if (map[text]) return map[text];

  const strategy = text.match(/^strategy=(.+)$/i);
  if (strategy) return `策略：${strategyDisplayName(strategy[1]!)}`;
  const topology = text.match(/^topology=(.+)$/i);
  if (topology) return `拓扑：${topologyDisplayName(topology[1]!)}`;
  const status = text.match(/^status=(.+)$/i);
  if (status) return `状态：${runStatusLabel(status[1]!)}`;
  const tasks = text.match(/^tasks>=(\d+)$/i);
  if (tasks) return `任务数≥${tasks[1]}`;
  const role = text.match(/^role=(.+)$/i);
  if (role) return `角色：${agentRoleLabel(role[1]!)}`;
  return text;
}

export function formatExperienceTag(tag: string): string {
  const map: Record<string, string> = {
    failure: "失败",
    success: "成功",
    rework: "返工",
    planning: "规划",
    tooling: "工具",
    provider: "模型",
    "control-plane": "控制面",
  };
  if (map[tag]) return map[tag];
  const strategy = tag.match(/^strategy:(.+)$/i);
  if (strategy) return `策略:${strategyDisplayName(strategy[1]!)}`;
  const topology = tag.match(/^topology:(.+)$/i);
  if (topology) return `拓扑:${topologyDisplayName(topology[1]!)}`;
  return tag;
}
