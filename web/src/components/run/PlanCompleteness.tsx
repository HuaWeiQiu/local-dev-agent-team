import { AlertTriangle, CheckCircle2, ChevronDown, ShieldAlert } from "lucide-react";
import type { PlanCompletenessReport } from "../../plan-completeness";
import { cn } from "../../ui/cn";

type Tone = "success" | "warning" | "danger";

const toneClass: Record<Tone, string> = {
  success: "border-success/35 bg-success-soft text-success-ink",
  warning: "border-warning/40 bg-warning-soft text-warning-ink",
  danger: "border-danger/35 bg-danger-soft text-danger-ink",
};

const toneIcon = { success: CheckCircle2, warning: AlertTriangle, danger: ShieldAlert } as const;

interface PlanCompletenessProps {
  report: PlanCompletenessReport;
  tone: Tone;
  title: string;
  taskCount: number;
}

/** Collapsible plan-coverage verdict; opens by default whenever the plan is not fully complete. */
export function PlanCompleteness({ report, tone, title, taskCount }: PlanCompletenessProps) {
  const Icon = toneIcon[tone];
  const summary = report.namedDeliverables.length > 0
    ? `覆盖 ${report.coveredDeliverables.length}/${report.namedDeliverables.length}`
    : `${taskCount} 条任务`;
  return (
    <details open={report.status !== "complete"} className={cn("group rounded-lg border border-solid px-3 py-2 text-xs", toneClass[tone])}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm focus-ring [&::-webkit-details-marker]:hidden">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <strong className="font-semibold">{title}</strong>
        <span className="ml-auto text-muted">{summary}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      {report.issues.length > 0 ? (
        <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-5 leading-relaxed text-ink-2">
          {report.issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : (
        <p className="m-0 mt-2 leading-relaxed text-ink-2">目标编号已覆盖，无只读独苗。</p>
      )}
    </details>
  );
}
