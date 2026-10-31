import {
  advisorTriggerLabel,
  agentRoleLabel,
  formatBytes,
  profileDisplayName,
  strategyDisplayName,
} from "../../../presentation";
import { formatDuration } from "../inspector-parts";
import type { ApprovalRequest, RoleBindingInput, RunState } from "../../../types";

export const APPROVAL_TONE = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
} as const;

export const APPROVAL_BAR = {
  pending: "bg-warning",
  approved: "bg-success",
  rejected: "bg-danger",
} as const;

export function approvalLabel(status: ApprovalRequest["status"]): string {
  if (status === "pending") return "待处理";
  if (status === "approved") return "已批准";
  return "已拒绝";
}

export function gateLabel(gate: ApprovalRequest["gate"]): string {
  return gate === "plan" ? "执行计划" : "交付结果";
}

export function checkpointLabel(stage: string): string {
  const labels: Record<string, string> = {
    "plan-ready": "计划完成",
    "task-wave-integrated": "任务波次已合并",
    "tasks-complete": "任务全部完成",
    "local-gates-passed": "本地门禁通过",
  };
  return labels[stage] ?? stage;
}

export interface RoleRow {
  role: string;
  label: string;
  detail: string;
  title: string;
}

/** Role rows: an explicit CLI binding wins over the strategy's profile name. */
export function roleRows(run: RunState): RoleRow[] {
  const profiles = { ...run.strategy.roleProfiles, ...run.profileOverrides };
  return Object.entries(profiles).map(([role, profile]) => ({
    role,
    label: agentRoleLabel(role),
    detail: bindingSummary(run.roleBindings?.[role]) ?? profileDisplayName(profile),
    title: profile,
  }));
}

export function bindingSummary(binding: RoleBindingInput | undefined): string | undefined {
  if (!binding) return undefined;
  const model = binding.model ?? "默认模型";
  return binding.reasoning
    ? `${binding.cli} · ${model} · ${binding.reasoning}`
    : `${binding.cli} · ${model}`;
}

export function hasRoleRows(run: RunState): boolean {
  return (
    Object.keys(run.strategy.roleProfiles).length > 0 ||
    Object.keys(run.profileOverrides).length > 0
  );
}

export function hasCliBindings(run: RunState): boolean {
  return Object.keys(run.roleBindings ?? {}).length > 0;
}

export function strategyRows(run: RunState): Array<{ term: string; value: string }> {
  return [...baseStrategyRows(run), ...advisorTriggerRow(run)];
}

function baseStrategyRows(run: RunState): Array<{ term: string; value: string }> {
  const strategy = run.strategy;
  return [
    { term: "名称", value: strategyDisplayName(strategy.name) },
    { term: "并行上限", value: String(strategy.maxParallel) },
    { term: "Swarm 并发", value: String(strategy.swarmMaxConcurrency ?? strategy.maxParallel) },
    { term: "代码探索", value: strategy.explore?.enabled ? "已启用" : "关闭" },
    { term: "返工上限", value: String(strategy.maxReworkAttempts) },
    { term: "架构顾问", value: advisorSummary(run) },
  ];
}

function advisorTriggerRow(run: RunState): Array<{ term: string; value: string }> {
  const advisor = run.strategy.advisor;
  if (!advisor?.enabled) return [];
  return [{ term: "顾问触发", value: advisor.triggers.map(advisorTriggerLabel).join("、") }];
}

function advisorSummary(run: RunState): string {
  const advisor = run.strategy.advisor;
  if (!advisor?.enabled) return "关闭";
  return `已启用 · ${run.advisorConsultations ?? 0} / ${advisor.maxConsultationsPerRun} 次`;
}

export function usageRows(run: RunState): Array<{ term: string; value: string }> {
  return [...baseUsageRows(run), ...tokenRow(run), ...costRow(run)];
}

function baseUsageRows(run: RunState): Array<{ term: string; value: string }> {
  const usage = run.usage;
  return [
    {
      term: "角色调用",
      value: `${orZero(usage?.agentInvocations)} / ${orZero(run.strategy.maxAgentInvocations, 64)}`,
    },
    { term: "角色耗时", value: formatDuration(orZero(usage?.agentDurationMs)) },
    { term: "输出捕获", value: formatBytes(orZero(usage?.processOutputBytes)) },
    { term: "截断流", value: String(orZero(usage?.truncatedStreams)) },
  ];
}

function tokenRow(run: RunState): Array<{ term: string; value: string }> {
  if (!hasReportedTokens(run)) return [];
  const usage = run.usage!;
  return [
    {
      term: "已报告 Token",
      value: `${orZero(usage.inputTokens).toLocaleString()} 入 / ${orZero(usage.outputTokens).toLocaleString()} 出`,
    },
  ];
}

function hasReportedTokens(run: RunState): boolean {
  const usage = run.usage;
  if (!usage) return false;
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined;
}

/** Undefined numbers fall back to the caller's default (0 unless stated). */
function orZero(value: number | undefined, fallback = 0): number {
  return value ?? fallback;
}

function costRow(run: RunState): Array<{ term: string; value: string }> {
  const cost = run.usage?.reportedCostUsd;
  if (cost === undefined) return [];
  return [{ term: "已报告成本", value: `$${cost.toFixed(4)}` }];
}

export function artifactRow(run: RunState): { term: string; value: string } {
  const usage = run.usage;
  return {
    term: "运行产物",
    value: `${formatBytes(usage?.artifactBytes ?? 0)} / ${formatBytes(run.strategy.maxArtifactBytes ?? 1_073_741_824)}`,
  };
}
