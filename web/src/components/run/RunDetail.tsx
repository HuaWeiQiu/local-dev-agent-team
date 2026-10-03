import { CheckCircle2, Clock3, Gauge, GitBranch, History, ShieldAlert, UserRound } from "lucide-react";
import { completenessBarCopy, planCompletenessForRun } from "../../plan-completeness";
import { advisorTriggerLabel, agentRoleLabel, formatBytes, humanizeFailure, profileDisplayName, strategyDisplayName } from "../../presentation";
import type { RunState } from "../../types";
import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import {
  Definition,
  DefinitionList,
  InlineError,
  InspectorCode,
  InspectorSection,
  Verdict,
  describeRunFailure,
  formatDuration,
} from "./inspector-parts";

const approvalTone = { pending: "warning", approved: "success", rejected: "danger" } as const;
const approvalBar = { pending: "bg-warning", approved: "bg-success", rejected: "bg-danger" } as const;

export function RunDetail({ run }: { run: RunState }) {
  const planReport = planCompletenessForRun(run);
  const planCopy = planReport ? completenessBarCopy(planReport) : undefined;
  const lastCheckpoint = run.checkpoints?.at(-1);
  return (
    <>
      <section className="bd-b px-4 py-4">
        <code className="block break-all text-2xs text-accent-ink">{run.id}</code>
        <h3 className="m-0 mt-1.5 break-words text-base font-semibold leading-snug text-ink">{run.goal}</h3>
        {run.plan && <p className="m-0 mt-2 break-words text-xs leading-relaxed text-ink-2">{run.plan.summary}</p>}
      </section>
      {planReport && planCopy ? (
        <InspectorSection icon={CheckCircle2} title="计划完备">
          <Badge tone={planCopy.tone}>{planCopy.title}</Badge>
          {planReport.namedDeliverables.length > 0 && (
            <p className="m-0 mt-2 break-words text-xs leading-relaxed text-muted">
              覆盖 {planReport.coveredDeliverables.join(", ") || "无"} / {planReport.namedDeliverables.join(", ")}
            </p>
          )}
          {planReport.issues.length > 0 && (
            <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-ink-2">
              {planReport.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          )}
        </InspectorSection>
      ) : null}
      {run.finalQuality && !run.finalQuality.passed ? (
        <InspectorSection icon={ShieldAlert} title="集成质量门">
          <InlineErrorBlock>{describeRunFailure(run)}</InlineErrorBlock>
        </InspectorSection>
      ) : null}
      <InspectorSection icon={GitBranch} title="策略">
        <DefinitionList>
          <Definition term="名称" title={run.strategy.name}>{strategyDisplayName(run.strategy.name)}</Definition>
          <Definition term="并行上限">{run.strategy.maxParallel}</Definition>
          <Definition term="Swarm 并发">{run.strategy.swarmMaxConcurrency ?? run.strategy.maxParallel}</Definition>
          <Definition term="代码探索">{run.strategy.explore?.enabled ? "已启用" : "关闭"}</Definition>
          <Definition term="返工上限">{run.strategy.maxReworkAttempts}</Definition>
          <Definition term="架构顾问">
            {run.strategy.advisor?.enabled
              ? `已启用 · ${run.advisorConsultations ?? 0} / ${run.strategy.advisor.maxConsultationsPerRun} 次`
              : "关闭"}
          </Definition>
          {run.strategy.advisor?.enabled && (
            <Definition term="顾问触发">{run.strategy.advisor.triggers.map(advisorTriggerLabel).join("、")}</Definition>
          )}
          {run.parentRunId && <Definition term="来源运行"><InspectorCode>{run.parentRunId}</InspectorCode></Definition>}
        </DefinitionList>
      </InspectorSection>
      <InspectorSection icon={CheckCircle2} title="角色分配">
        <DefinitionList>
          {Object.entries({ ...run.strategy.roleProfiles, ...run.profileOverrides }).map(([role, profile]) => {
            const binding = run.roleBindings?.[role];
            return (
              <Definition key={role} term={agentRoleLabel(role)} title={profile}>
                {binding
                  ? `${binding.cli} · ${binding.model ?? "默认模型"}${binding.reasoning ? ` · ${binding.reasoning}` : ""}`
                  : profileDisplayName(profile)}
              </Definition>
            );
          })}
          {Object.keys(run.strategy.roleProfiles).length === 0 && Object.keys(run.profileOverrides).length === 0 && (
            <Definition term="配置">使用角色默认值</Definition>
          )}
        </DefinitionList>
        {run.roleBindings && Object.keys(run.roleBindings).length > 0 && (
          <small className="mt-3 block text-2xs leading-relaxed text-muted">CLI 绑定：本次运行按全局/选型配置使用了上述 CLI 与模型</small>
        )}
      </InspectorSection>
      {run.approvals && run.approvals.length > 0 && (
        <InspectorSection icon={UserRound} title="人工审批">
          <div className="flex flex-col gap-2">
            {[...run.approvals].reverse().map((approval) => (
              <div key={approval.id} className="relative overflow-hidden rounded-md bg-surface-2 py-2.5 pl-4 pr-3">
                <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", approvalBar[approval.status])} />
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-xs font-medium text-ink">{approval.gate === "plan" ? "执行计划" : "交付结果"}</strong>
                  <Badge tone={approvalTone[approval.status]}>
                    {approval.status === "pending" ? "待处理" : approval.status === "approved" ? "已批准" : "已拒绝"}
                  </Badge>
                </div>
                <p className="m-0 mt-1.5 break-words text-xs leading-relaxed text-ink-2">{approval.summary}</p>
                {approval.response ? (
                  <small className="mt-1.5 block break-words text-2xs leading-snug text-muted">{approval.response.actor} · {approval.response.reason}</small>
                ) : (
                  <small className="mt-1.5 flex items-center gap-1 text-2xs leading-snug text-muted">
                    <Clock3 aria-hidden className="size-3" />{new Date(approval.expiresAt).toLocaleString("zh-CN")}
                  </small>
                )}
              </div>
            ))}
          </div>
        </InspectorSection>
      )}
      {lastCheckpoint && (
        <InspectorSection icon={History} title="恢复边界">
          <DefinitionList>
            <Definition term="阶段">{checkpointLabel(lastCheckpoint.stage)}</Definition>
            <Definition term="集成提交"><InspectorCode>{lastCheckpoint.integrationCommit.slice(0, 10)}</InspectorCode></Definition>
            <Definition term="已完成任务">{lastCheckpoint.completedTaskIds.length}</Definition>
            <Definition term="恢复次数">{run.resumeCount ?? 0}</Definition>
          </DefinitionList>
        </InspectorSection>
      )}
      <InspectorSection icon={Gauge} title="资源与追踪">
        <DefinitionList>
          <Definition term="角色调用">{run.usage?.agentInvocations ?? 0} / {run.strategy.maxAgentInvocations ?? 64}</Definition>
          <Definition term="角色耗时">{formatDuration(run.usage?.agentDurationMs ?? 0)}</Definition>
          <Definition term="输出捕获">{formatBytes(run.usage?.processOutputBytes ?? 0)}</Definition>
          <Definition term="运行产物">{formatBytes(run.usage?.artifactBytes ?? 0)} / {formatBytes(run.strategy.maxArtifactBytes ?? 1_073_741_824)}</Definition>
          <Definition term="截断流">{run.usage?.truncatedStreams ?? 0}</Definition>
          {(run.usage?.inputTokens !== undefined || run.usage?.outputTokens !== undefined) && (
            <Definition term="已报告 Token">{(run.usage.inputTokens ?? 0).toLocaleString()} 入 / {(run.usage.outputTokens ?? 0).toLocaleString()} 出</Definition>
          )}
          {run.usage?.reportedCostUsd !== undefined && (
            <Definition term="已报告成本">${run.usage.reportedCostUsd.toFixed(4)}</Definition>
          )}
          <Definition term="Trace ID"><InspectorCode>{run.traceId ?? "加载事件后生成"}</InspectorCode></Definition>
        </DefinitionList>
      </InspectorSection>
      {run.finalDecision && (
        <InspectorSection icon={ShieldAlert} title="最终判定">
          <Verdict label={run.finalDecision.decision} verdict={run.finalDecision.decision} summary={run.finalDecision.reason} />
        </InspectorSection>
      )}
      {run.error && <InlineError>{humanizeFailure(run.error)}</InlineError>}
    </>
  );
}

function InlineErrorBlock({ children }: { children: string }) {
  return <p className="m-0 break-words rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger-ink">{children}</p>;
}

function checkpointLabel(stage: string): string {
  return {
    "plan-ready": "计划完成",
    "task-wave-integrated": "任务波次已合并",
    "tasks-complete": "任务全部完成",
    "local-gates-passed": "本地门禁通过",
  }[stage] ?? stage;
}
