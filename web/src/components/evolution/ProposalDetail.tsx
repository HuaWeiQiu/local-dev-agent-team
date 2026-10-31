import { ArrowLeft, Check, FileCheck2, GitCompareArrows, History } from "lucide-react";
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
import { Card } from "../../ui/card";
import { cn } from "../../ui/cn";
import { normalizeTone, StatusDot } from "../../ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { ActionButton, Kicker } from "./controls";
import { auditLabel, completedLabel, formatDate } from "./format";
import { Overview } from "./detail/overview";
import {
  EvidenceCallout,
  EvidenceEmpty,
  EvidenceHeader,
  EvidenceList,
  evidenceVerdict,
} from "./detail/evidence";
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

function ProgressStep({
  label,
  number,
  total,
  step,
}: {
  label: string;
  number: number;
  total: number;
  step: number;
}) {
  const done = number === 1 || step >= number;
  return (
    <li className={cn("flex items-center", number < total && "flex-1")}>
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
        <span className={cn("whitespace-nowrap text-xs", done ? "font-semibold text-ink" : "text-muted")}>
          {label}
        </span>
      </span>
      {number < total && (
        <span
          aria-hidden
          className={cn("mx-3 h-px min-w-4 flex-1", step > number ? "bg-accent" : "bg-line-strong")}
        />
      )}
    </li>
  );
}

function ProgressSteps({ proposal }: { proposal: EvolutionProposal }) {
  const { step, finalLabel } = proposalProgress(proposal);
  const automatic = proposal.evaluation?.source === automaticSource;
  const labels = ["候选", automatic ? "隔离评测" : "结构预检", automatic ? "自动比较" : "人工决定", finalLabel];
  return (
    <ol aria-label="候选进度" className="scroll-thin m-0 flex list-none items-center overflow-x-auto px-4 pb-3.5 pt-3 md:px-6">
      {labels.map((label, index) => (
        <ProgressStep key={label} label={label} number={index + 1} total={labels.length} step={step} />
      ))}
    </ol>
  );
}

function Evidence({ proposal }: { proposal: EvolutionProposal }) {
  const { evaluation } = proposal;
  if (!evaluation) return <EvidenceEmpty />;
  const verdict = evidenceVerdict(evaluation);
  return (
    <>
      <EvidenceHeader verdict={verdict} />
      <EvidenceCallout verdict={verdict} />
      <EvidenceList items={evaluation.evidence.items} />
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
