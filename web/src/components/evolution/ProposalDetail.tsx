import { ArrowLeft, Check, CheckCircle2, CircleAlert, FileCheck2, GitCompareArrows, History, LockKeyhole, ShieldCheck } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import {
  evolutionStatusLabels,
  proposalProgress,
  proposalStatusLabel,
  proposalStatusTone,
  proposalTarget,
  proposalTitle,
} from "../../evolution";
import type { EvolutionAuditRecord, EvolutionCompletedApplication, EvolutionProposal } from "../../types";
import { Badge } from "../../ui/badge";
import { Card, SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";
import { Callout } from "../../ui/form";
import { normalizeTone, StatusDot } from "../../ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { ActionButton, Kicker } from "./controls";
import { auditLabel, completedLabel, evidenceItemSummary, formatDate } from "./format";
import { KindIcon } from "./KindIcon";

export type DetailTab = "overview" | "evidence" | "history";

interface ProposalDetailProps {
  proposal: EvolutionProposal;
  audit: EvolutionAuditRecord[];
  completed: EvolutionCompletedApplication[];
  tab: DetailTab;
  scrollable: boolean;
  actions: ReactNode;
  notes: ReactNode;
  onTabChange(tab: DetailTab): void;
  onBack: (() => void) | undefined;
}

const automaticSource = "server-automatic-run-evaluation-v1";

export function ProposalDetail({ proposal, audit, completed, tab, scrollable, actions, notes, onTabChange, onBack }: ProposalDetailProps) {
  const tone = normalizeTone(proposalStatusTone(proposal));
  const strategy = proposal.candidate.kind === "strategy-blueprint";
  return (
    <main className={cn("flex min-w-0 flex-1 flex-col bg-background", scrollable && "min-h-0")}>
      <div className="bd-b shrink-0 bg-surface">
        <header className="evolution-detail-header">
          <div className="flex items-center gap-3 px-4 pt-3.5 md:px-6">
            {onBack && (
              <ActionButton variant="ghost" size="icon" className="-ml-2" onClick={onBack} aria-label="返回候选列表">
                <ArrowLeft />
              </ActionButton>
            )}
            <KindIcon kind={proposal.candidate.kind} className="size-9" />
            <div className="min-w-0 flex-1">
              <Kicker>{strategy ? "执行策略" : "角色提示词"}</Kicker>
              <h1 className="m-0 mt-1.5 truncate text-lg font-semibold leading-none tracking-tight text-ink">{proposalTitle(proposal)}</h1>
              <small className="mt-1.5 block truncate text-xs text-muted">{proposalTarget(proposal)}</small>
            </div>
            <span className="status-badge contents before:hidden!">
              <Badge tone={tone}>
                <StatusDot tone={tone} pulse={tone === "active"} className="size-1.5" />
                {proposalStatusLabel(proposal)}
              </Badge>
            </span>
          </div>
        </header>
        <ProgressSteps proposal={proposal} />
      </div>

      {actions ? <div className="bd-b shrink-0 px-4 py-3 md:px-6">{actions}</div> : null}

      <Tabs value={tab} onValueChange={(value) => onTabChange(value as DetailTab)} className={cn("flex flex-1 flex-col", scrollable && "min-h-0")}>
        <TabsList role="tablist" aria-label="候选详情" className="shrink-0 bg-surface px-3 md:px-5">
          <DetailTrigger value="overview" icon={<GitCompareArrows />} label="概览" />
          <DetailTrigger value="evidence" icon={<FileCheck2 />} label="预检" />
          <DetailTrigger value="history" icon={<History />} label="记录" />
        </TabsList>
        <div className={cn("flex-1", scrollable && "scroll-thin min-h-0 overflow-y-auto")}>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6">
            <TabsContent value="overview" className="flex flex-col gap-4 outline-none">
              <Overview proposal={proposal} />
            </TabsContent>
            <TabsContent value="evidence" className="flex flex-col gap-4 outline-none">
              <Evidence proposal={proposal} />
            </TabsContent>
            <TabsContent value="history" className="outline-none">
              <HistoryView proposal={proposal} audit={audit} completed={completed} />
            </TabsContent>
            {notes}
          </div>
        </div>
      </Tabs>
    </main>
  );
}

function DetailTrigger({ value, icon, label }: { value: DetailTab; icon: ReactNode; label: string }) {
  return (
    <TabsTrigger value={value} className="border-0 border-b-2 bg-transparent">
      {icon}
      {label}
    </TabsTrigger>
  );
}

function ProgressSteps({ proposal }: { proposal: EvolutionProposal }) {
  const { step, finalLabel } = proposalProgress(proposal);
  const automatic = proposal.evaluation?.source === automaticSource;
  const labels = ["候选", automatic ? "隔离评测" : "结构预检", automatic ? "自动比较" : "人工决定", finalLabel];
  return (
    <ol aria-label="候选进度" className="scroll-thin m-0 flex list-none items-center overflow-x-auto px-4 pb-3.5 pt-3 md:px-6">
      {labels.map((label, index) => {
        const number = index + 1;
        const done = number === 1 || step >= number;
        return (
          <li key={number} className={cn("flex items-center", number < labels.length && "flex-1")}>
            <span className="flex shrink-0 items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "grid size-5 place-items-center rounded-full text-2xs font-semibold tabular-nums",
                  done ? "bg-accent text-on-accent" : "bd-strong bg-surface text-muted",
                )}
              >
                {done && number < step ? <Check className="size-3" strokeWidth={3} /> : number}
              </span>
              <span className={cn("whitespace-nowrap text-xs", done ? "font-semibold text-ink" : "text-muted")}>{label}</span>
            </span>
            {number < labels.length && (
              <span aria-hidden className={cn("mx-3 h-px min-w-4 flex-1", step > number ? "bg-accent" : "bg-line-strong")} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Overview({ proposal }: { proposal: EvolutionProposal }) {
  const { candidate } = proposal;
  const automatic = proposal.evaluation?.source === automaticSource;
  return (
    <>
      <Card className="flex flex-col gap-2 p-5">
        <SectionTitle>变更目标</SectionTitle>
        <h2 className="m-0 text-base font-semibold tracking-tight text-ink">{proposalTarget(proposal)}</h2>
        <p className="m-0 max-w-prose text-sm leading-relaxed text-ink-2">
          {candidate.kind === "strategy-blueprint"
            ? "候选将更新一个本地自定义执行策略。应用前会再次比较目标摘要。"
            : "候选指向项目已配置的角色提示词。内容只在精确预览和本地对象存储中使用。"}
        </p>
      </Card>

      {candidate.kind === "strategy-blueprint" ? (
        <Card className="flex flex-col gap-3 p-5">
          <SectionTitle>执行参数</SectionTitle>
          <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-line sm:grid-cols-3">
            <Stat label="拓扑" value={candidate.definition.topology?.mode === "sequential" ? "顺序执行" : "依赖并行"} />
            <Stat label="最大并行" value={candidate.definition.maxParallel ?? "默认"} />
            <Stat label="最多返工" value={candidate.definition.maxReworkAttempts ?? "默认"} />
            <Stat label="角色调用上限" value={candidate.definition.maxAgentInvocations ?? "默认"} />
            <Stat label="执行超时" value={candidate.definition.executionTimeoutSeconds ? `${candidate.definition.executionTimeoutSeconds} 秒` : "默认"} />
            <Stat label="人工门禁" value={candidate.definition.approvalGates?.join("、") || "沿用默认"} />
          </dl>
        </Card>
      ) : (
        <Card className="flex flex-col gap-3 p-5">
          <SectionTitle>材料摘要</SectionTitle>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">仓库路径</dt>
            <dd className="m-0 min-w-0"><code className="break-all rounded bg-surface-3 px-1.5 py-0.5 text-xs">{candidate.path}</code></dd>
            <dt className="text-muted">SHA-256</dt>
            <dd className="m-0 min-w-0"><code className="break-all rounded bg-surface-3 px-1.5 py-0.5 text-xs">{candidate.contentDigest}</code></dd>
          </dl>
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-5">
        <SectionTitle>候选权限</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {["不能自行执行", "不能自行晋升", "不网络发布", "不存储秘密"].map((label) => (
            <span key={label} className="bd inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs text-ink-2">
              <LockKeyhole aria-hidden className="size-3.5 text-muted" />
              {label}
            </span>
          ))}
        </div>
        {automatic && (
          <p className="m-0 text-xs leading-relaxed text-muted">自动演进由项目级受限控制器授权，候选策略本身始终没有执行或晋升权限。</p>
        )}
      </Card>
    </>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface-2 px-3 py-2.5">
      <dt className="text-2xs text-muted">{label}</dt>
      <dd className="m-0 break-words text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

function Evidence({ proposal }: { proposal: EvolutionProposal }) {
  const { evaluation } = proposal;
  if (!evaluation) {
    return (
      <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-surface-3 text-muted [&_svg]:size-5"><FileCheck2 /></span>
        <strong className="text-sm font-medium text-ink-2">尚未运行结构预检</strong>
        <span className="text-xs text-muted">预检由服务端生成并绑定当前候选。</span>
      </Card>
    );
  }
  const automatic = evaluation.source === automaticSource;
  const passed = evaluation.result.passed;
  return (
    <>
      <Card className={cn("flex items-start gap-3 p-5", passed ? "bg-success-soft" : "bg-danger-soft")}>
        <span aria-hidden className={cn("mt-0.5 shrink-0 [&_svg]:size-5", passed ? "text-success-ink" : "text-danger-ink")}>
          {passed ? <CheckCircle2 /> : <CircleAlert />}
        </span>
        <div className="min-w-0">
          <strong className={cn("block text-base font-semibold", passed ? "text-success-ink" : "text-danger-ink")}>
            {passed ? (automatic ? "隔离评测通过" : "结构预检通过") : (automatic ? "隔离评测未通过" : "结构预检未通过")}
          </strong>
          <p className="m-0 mt-1 text-sm leading-relaxed text-ink-2">
            {passed
              ? (automatic ? "候选通过固定目标的隔离运行，并达到配置的最低分数提升。" : "所有确定性检查均已通过，未出现否决项。")
              : evaluation.result.summary}
          </p>
        </div>
      </Card>

      <Callout tone="info">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
          {automatic
            ? "结果来自项目内隔离工作树的固定目标运行；不包含自动发布，也不授予候选自执行权限。"
            : "此结果只验证结构和本地安全条件，未执行候选策略或提示词。"}
        </span>
      </Callout>

      <Card className="overflow-hidden">
        <ul className="m-0 list-none p-0">
          {evaluation.evidence.items.map((item, index) => {
            const itemPassed = item.kind === "deterministic" ? item.status === "pass" : item.verdict === "approve";
            return (
              <li key={item.id} className={cn("flex items-start gap-3 px-4 py-3", index > 0 && "bd-t")}>
                <span aria-hidden className={cn("mt-0.5 shrink-0 [&_svg]:size-4", itemPassed ? "text-success" : "text-danger")}>
                  {itemPassed ? <CheckCircle2 /> : <CircleAlert />}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <strong className="text-sm font-medium leading-snug text-ink">{evidenceItemSummary(item.id, item.summary, itemPassed)}</strong>
                  <code className="break-all text-2xs text-muted">{item.id}</code>
                </div>
                <Badge tone={itemPassed ? "success" : "danger"}>
                  {item.kind === "deterministic" ? (item.status === "pass" ? "通过" : "失败") : item.verdict}
                </Badge>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}

function HistoryView({ proposal, audit, completed }: { proposal: EvolutionProposal; audit: EvolutionAuditRecord[]; completed: EvolutionCompletedApplication[] }) {
  const rows = useMemo(
    () => [
      { at: proposal.createdAt, label: "创建候选", detail: proposalTarget(proposal) },
      ...proposal.transitions.map((transition) => ({
        at: transition.at,
        label: evolutionStatusLabels[transition.to],
        detail: `${evolutionStatusLabels[transition.from]} → ${evolutionStatusLabels[transition.to]}`,
      })),
      ...audit.map((record) => ({ at: record.at, label: auditLabel(record.kind), detail: record.reason })),
      ...completed.map((record) => ({ at: record.completedAt, label: completedLabel(record.operation), detail: record.reason })),
    ].sort((left, right) => right.at.localeCompare(left.at)),
    [proposal, audit, completed],
  );
  return (
    <Card className="px-5 py-2">
      <ol className="m-0 list-none p-0">
        {rows.map((row, index) => (
          <li key={`${row.at}-${row.label}-${index}`} className="relative flex gap-3 pb-4 pt-3 first:pt-3 last:pb-3">
            {index < rows.length - 1 && <span aria-hidden className="absolute bottom-0 left-[3px] top-[1.6rem] w-px bg-line" />}
            <span aria-hidden className="relative mt-1.5 size-[7px] shrink-0 rounded-full bg-accent" />
            <div className="min-w-0 flex-1">
              <strong className="text-sm font-medium text-ink">{row.label}</strong>
              <p className="m-0 mt-0.5 break-words text-xs leading-relaxed text-muted">{row.detail}</p>
            </div>
            <time className="shrink-0 text-2xs tabular-nums text-muted">{formatDate(row.at)}</time>
          </li>
        ))}
      </ol>
    </Card>
  );
}
