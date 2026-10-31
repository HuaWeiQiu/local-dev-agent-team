import { CheckCircle2, Clock3, Gauge, GitBranch, History, ShieldAlert, UserRound } from "lucide-react";
import { completenessBarCopy, planCompletenessForRun } from "../../../plan-completeness";
import { humanizeFailure } from "../../../presentation";
import type { ApprovalRequest, RunState } from "../../../types";
import { Badge } from "../../../ui/badge";
import { cn } from "../../../ui/cn";
import {
  Definition,
  DefinitionList,
  InlineError,
  InspectorCode,
  InspectorSection,
  Verdict,
  describeRunFailure,
} from "../inspector-parts";
import {
  APPROVAL_BAR,
  APPROVAL_TONE,
  approvalLabel,
  artifactRow,
  checkpointLabel,
  gateLabel,
  hasCliBindings,
  hasRoleRows,
  roleRows,
  strategyRows,
  usageRows,
} from "./model";

export function RunSummary({ run }: { run: RunState }) {
  return (
    <section className="bd-b px-4 py-4">
      <code className="block break-all text-2xs text-accent-ink">{run.id}</code>
      <h3 className="m-0 mt-1.5 break-words text-base font-semibold leading-snug text-ink">{run.goal}</h3>
      {run.plan && (
        <p className="m-0 mt-2 break-words text-xs leading-relaxed text-ink-2">{run.plan.summary}</p>
      )}
    </section>
  );
}

export function PlanCompleteness({ run }: { run: RunState }) {
  const report = planCompletenessForRun(run);
  if (!report) return null;
  const copy = completenessBarCopy(report);
  return (
    <InspectorSection icon={CheckCircle2} title="计划完备">
      <Badge tone={copy.tone}>{copy.title}</Badge>
      {report.namedDeliverables.length > 0 && (
        <p className="m-0 mt-2 break-words text-xs leading-relaxed text-muted">
          覆盖 {report.coveredDeliverables.join(", ") || "无"} / {report.namedDeliverables.join(", ")}
        </p>
      )}
      {report.issues.length > 0 && (
        <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-4 text-xs leading-relaxed text-ink-2">
          {report.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

export function QualityGate({ run }: { run: RunState }) {
  if (!run.finalQuality || run.finalQuality.passed) return null;
  return (
    <InspectorSection icon={ShieldAlert} title="集成质量门">
      <p className="m-0 break-words rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger-ink">
        {describeRunFailure(run)}
      </p>
    </InspectorSection>
  );
}

export function StrategySection({ run }: { run: RunState }) {
  return (
    <InspectorSection icon={GitBranch} title="策略">
      <DefinitionList>
        {strategyRows(run).map((row) => (
          <Definition key={row.term} term={row.term} title={row.value}>
            {row.value}
          </Definition>
        ))}
        {run.parentRunId && (
          <Definition term="来源运行">
            <InspectorCode>{run.parentRunId}</InspectorCode>
          </Definition>
        )}
      </DefinitionList>
    </InspectorSection>
  );
}

export function RolesSection({ run }: { run: RunState }) {
  return (
    <InspectorSection icon={CheckCircle2} title="角色分配">
      <DefinitionList>
        {roleRows(run).map((row) => (
          <Definition key={row.role} term={row.label} title={row.title}>
            {row.detail}
          </Definition>
        ))}
        {!hasRoleRows(run) && <Definition term="配置">使用角色默认值</Definition>}
      </DefinitionList>
      {hasCliBindings(run) && (
        <small className="mt-3 block text-2xs leading-relaxed text-muted">
          CLI 绑定：本次运行按全局/选型配置使用了上述 CLI 与模型
        </small>
      )}
    </InspectorSection>
  );
}

export function ApprovalsSection({ run }: { run: RunState }) {
  const approvals = run.approvals ?? [];
  if (approvals.length === 0) return null;
  return (
    <InspectorSection icon={UserRound} title="人工审批">
      <div className="flex flex-col gap-2">
        {[...approvals].reverse().map((approval) => (
          <ApprovalRow key={approval.id} approval={approval} />
        ))}
      </div>
    </InspectorSection>
  );
}

function ApprovalRow({ approval }: { approval: ApprovalRequest }) {
  return (
    <div className="relative overflow-hidden rounded-md bg-surface-2 py-2.5 pl-4 pr-3">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", APPROVAL_BAR[approval.status])} />
      <div className="flex items-center justify-between gap-2">
        <strong className="text-xs font-medium text-ink">{gateLabel(approval.gate)}</strong>
        <Badge tone={APPROVAL_TONE[approval.status]}>{approvalLabel(approval.status)}</Badge>
      </div>
      <p className="m-0 mt-1.5 break-words text-xs leading-relaxed text-ink-2">{approval.summary}</p>
      <ApprovalFoot approval={approval} />
    </div>
  );
}

function ApprovalFoot({ approval }: { approval: ApprovalRequest }) {
  if (approval.response) {
    return (
      <small className="mt-1.5 block break-words text-2xs leading-snug text-muted">
        {approval.response.actor} · {approval.response.reason}
      </small>
    );
  }
  return (
    <small className="mt-1.5 flex items-center gap-1 text-2xs leading-snug text-muted">
      <Clock3 aria-hidden className="size-3" />
      {new Date(approval.expiresAt).toLocaleString("zh-CN")}
    </small>
  );
}

export function CheckpointSection({ run }: { run: RunState }) {
  const checkpoint = run.checkpoints?.at(-1);
  if (!checkpoint) return null;
  return (
    <InspectorSection icon={History} title="恢复边界">
      <DefinitionList>
        <Definition term="阶段">{checkpointLabel(checkpoint.stage)}</Definition>
        <Definition term="集成提交">
          <InspectorCode>{checkpoint.integrationCommit.slice(0, 10)}</InspectorCode>
        </Definition>
        <Definition term="已完成任务">{checkpoint.completedTaskIds.length}</Definition>
        <Definition term="恢复次数">{run.resumeCount ?? 0}</Definition>
      </DefinitionList>
    </InspectorSection>
  );
}

export function UsageSection({ run }: { run: RunState }) {
  return (
    <InspectorSection icon={Gauge} title="资源与追踪">
      <DefinitionList>
        {usageRows(run).map((row) => (
          <Definition key={row.term} term={row.term}>
            {row.value}
          </Definition>
        ))}
        <Definition term={artifactRow(run).term}>{artifactRow(run).value}</Definition>
        <Definition term="Trace ID">
          <InspectorCode>{run.traceId ?? "加载事件后生成"}</InspectorCode>
        </Definition>
      </DefinitionList>
    </InspectorSection>
  );
}

export function DecisionSection({ run }: { run: RunState }) {
  if (!run.finalDecision) return null;
  return (
    <InspectorSection icon={ShieldAlert} title="最终判定">
      <Verdict
        label={run.finalDecision.decision}
        verdict={run.finalDecision.decision}
        summary={run.finalDecision.reason}
      />
    </InspectorSection>
  );
}

export function RunError({ run }: { run: RunState }) {
  if (!run.error) return null;
  return <InlineError>{humanizeFailure(run.error)}</InlineError>;
}
