import { Clock3, ShieldQuestion } from "lucide-react";
import { completenessBarCopy, planCompletenessForRun } from "../plan-completeness";
import type { ApprovalRequest, RunState } from "../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface ApprovalCardProps {
  run: RunState;
  approval: ApprovalRequest;
  busy: boolean;
  onReview(): void;
}

/** Inline prompt for a pending human gate; the decision itself stays in the audited dialog. */
export function ApprovalCard({ run, approval, busy, onReview }: ApprovalCardProps) {
  const completeness = approval.gate === "plan" ? planCompletenessForRun(run) : undefined;
  const copy = completeness ? completenessBarCopy(completeness) : undefined;
  return (
    <section
      aria-label="待处理审批"
      className="relative flex flex-wrap items-center gap-3 overflow-hidden rounded-lg border border-solid border-warning/40 bg-warning-soft px-4 py-3 motion-safe:animate-[rise-in_220ms_ease-out]"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-warning" />
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-warning/20 text-warning-ink">
        <ShieldQuestion className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1 basis-64">
        <strong className="block text-sm font-semibold text-warning-ink">
          {approval.gate === "plan" ? "执行计划等待你审批" : "交付结果等待你审批"}
        </strong>
        <p className="m-0 mt-0.5 text-sm leading-snug text-ink-2">{approval.summary}</p>
        <small className="mt-1 flex items-center gap-2 text-2xs text-muted">
          <Clock3 className="size-3" aria-hidden="true" />
          截止 {new Date(approval.expiresAt).toLocaleString("zh-CN")}
          {copy && <Badge tone={copy.tone}>{copy.title}</Badge>}
        </small>
      </div>
      <Button variant="primary" onClick={onReview} disabled={busy}>
        审阅并处理
      </Button>
    </section>
  );
}
