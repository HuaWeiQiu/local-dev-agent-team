import { Clock3, ShieldQuestion } from "lucide-react";
import { completenessBarCopy, planCompletenessForRun } from "../plan-completeness";
import type { ApprovalRequest, RunState } from "../types";

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
    <section className="approval-card" aria-label="待处理审批">
      <ShieldQuestion size={18} aria-hidden="true" />
      <div className="approval-card-body">
        <strong>{approval.gate === "plan" ? "执行计划等待你审批" : "交付结果等待你审批"}</strong>
        <p>{approval.summary}</p>
        <small>
          <Clock3 size={11} aria-hidden="true" />
          截止 {new Date(approval.expiresAt).toLocaleString("zh-CN")}
          {copy && <span className={`approval-card-check tone-${copy.tone}`}>{copy.title}</span>}
        </small>
      </div>
      <button type="button" className="button primary" onClick={onReview} disabled={busy}>
        审阅并处理
      </button>
    </section>
  );
}
