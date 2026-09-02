import type { RunState } from "../state/types.js";

export interface RunAuditExport {
  exportedAt: string;
  runId: string;
  goal: string;
  status: string;
  strategy: string;
  operator?: string;
  baseBranch: string;
  headBranch: string;
  pullRequestUrl?: string;
  createdAt: string;
  updatedAt: string;
  stages: Array<{ title: string; summary: string; at: string }>;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    attempts: number;
    commit?: string;
  }>;
  approvals: Array<{
    gate: string;
    status: string;
    actor?: string;
    reason?: string;
    respondedAt?: string;
  }>;
}

export function buildRunAudit(state: RunState, operator?: string): RunAuditExport {
  return {
    exportedAt: new Date().toISOString(),
    runId: state.id,
    goal: state.goal,
    status: state.status,
    strategy: state.strategy.name,
    ...(operator ? { operator } : {}),
    baseBranch: state.baseBranch,
    headBranch: state.integrationBranch,
    ...(state.pullRequestUrl ? { pullRequestUrl: state.pullRequestUrl } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    stages: (state.stageSummaries ?? []).map((stage) => ({
      title: stage.title,
      summary: stage.summary,
      at: stage.at,
    })),
    tasks: state.tasks.map((task) => ({
      id: task.task.id,
      title: task.task.title,
      status: task.status,
      attempts: task.attempts,
      ...(task.commit ? { commit: task.commit } : {}),
    })),
    approvals: (state.approvals ?? []).map((approval) => ({
      gate: approval.gate,
      status: approval.status,
      ...(approval.response?.actor ? { actor: approval.response.actor } : {}),
      ...(approval.response?.reason ? { reason: approval.response.reason } : {}),
      ...(approval.response?.respondedAt ? { respondedAt: approval.response.respondedAt } : {}),
    })),
  };
}

export function renderRunAuditMarkdown(audit: RunAuditExport): string {
  const stages = audit.stages.length
    ? audit.stages.map((stage) => `- ${stage.title}（${stage.at}）：${stage.summary}`).join("\n")
    : "- 无阶段摘要";
  const tasks = audit.tasks.length
    ? audit.tasks.map((task) => `- \`${task.id}\` ${task.title} · ${task.status}${task.commit ? ` · ${task.commit.slice(0, 8)}` : ""}`).join("\n")
    : "- 无任务";
  const approvals = audit.approvals.length
    ? audit.approvals.map((item) => `- ${item.gate} · ${item.status}${item.actor ? ` · ${item.actor}` : ""}`).join("\n")
    : "- 无审批记录";
  return `# 运行审计 ${audit.runId}

- 导出时间：${audit.exportedAt}
- 状态：${audit.status}
- 策略：${audit.strategy}
- 分支：${audit.baseBranch} ← ${audit.headBranch}
${audit.pullRequestUrl ? `- PR：${audit.pullRequestUrl}\n` : ""}${audit.operator ? `- 操作者：${audit.operator}\n` : ""}
## 目标

${audit.goal}

## 阶段

${stages}

## 任务

${tasks}

## 审批

${approvals}
`;
}
