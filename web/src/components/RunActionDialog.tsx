import { Check, History, Pause, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { completenessBarCopy, planCompletenessForRun } from "../plan-completeness";
import type { ApprovalRequest, RunState } from "../types";
import { Button } from "../ui/button";
import { Modal } from "../ui/dialog";
import { Callout, Field, Input, Textarea } from "../ui/form";

interface RunActionDialogProps {
  mode: "approval" | "resume" | "pause" | undefined;
  approval?: ApprovalRequest;
  run?: RunState;
  busy: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: {
    decision?: "approved" | "rejected";
    actor: string;
    reason: string;
  }): Promise<void>;
}

export function RunActionDialog({
  mode,
  approval,
  run,
  busy,
  error,
  onClose,
  onSubmit,
}: RunActionDialogProps) {
  const [actor, setActor] = useState("");
  const [reason, setReason] = useState("");
  const [ackIncomplete, setAckIncomplete] = useState(false);

  useEffect(() => {
    if (mode) {
      setActor("");
      setReason("");
      setAckIncomplete(false);
    }
  }, [mode]);

  const completeness = mode && run && approval?.gate === "plan" ? planCompletenessForRun(run) : undefined;
  const incomplete = completeness !== undefined && completeness.status !== "complete";
  const approveBlocked = incomplete && !ackIncomplete;

  const execute = async (decision?: "approved" | "rejected") => {
    if (!actor.trim() || !reason.trim()) return;
    if (decision === "approved" && approveBlocked) return;
    await onSubmit({
      ...(decision ? { decision } : {}),
      actor: actor.trim(),
      reason: reason.trim(),
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void execute(mode === "approval" ? "approved" : undefined);
  };

  const title =
    mode === "approval"
      ? (approval?.gate === "plan" ? "审批执行计划" : "审批交付结果")
      : mode === "pause"
        ? "暂停运行"
        : "恢复运行";
  const ready = Boolean(actor.trim() && reason.trim());
  const formId = "run-action-form";

  return (
    <Modal
      open={Boolean(mode)}
      onOpenChange={(next) => !next && onClose()}
      title={title}
      description={mode === "approval" ? "人工门禁：记录操作者与理由后生效。" : mode === "pause" ? "暂停后可随时从检查点恢复。" : "从最近的检查点继续执行。"}
      className="w-[min(540px,calc(100vw-32px))]"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          {mode === "approval" && (
            <Button variant="danger" disabled={busy || !ready} onClick={() => void execute("rejected")}>
              <X />拒绝
            </Button>
          )}
          <Button type="submit" form={formId} variant="primary" disabled={busy || !ready || approveBlocked}>
            {mode === "approval" ? <Check /> : mode === "pause" ? <Pause /> : <History />}
            {busy ? "提交中" : mode === "approval" ? "批准" : mode === "pause" ? "暂停" : "恢复"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        {approval && (
          <div className="rounded-lg bg-warning-soft px-3 py-2.5 text-warning-ink">
            <strong className="block text-sm font-medium">{approval.summary}</strong>
            <span className="text-xs opacity-80">截止 {new Date(approval.expiresAt).toLocaleString("zh-CN")}</span>
          </div>
        )}
        {completeness ? (
          <Callout tone={completenessBarCopy(completeness).tone}>
            <strong className="block font-medium">{completenessBarCopy(completeness).title}</strong>
            {completeness.issues.length > 0 ? (
              <ul className="m-0 mt-1 list-disc pl-4">
                {completeness.issues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            ) : (
              <span>目标编号已覆盖。</span>
            )}
            {incomplete ? (
              <label className="mt-2 flex cursor-pointer items-center gap-2 font-medium">
                <input type="checkbox" className="size-3.5 accent-[var(--danger)]" checked={ackIncomplete} onChange={(event) => setAckIncomplete(event.target.checked)} />
                我知道计划不完整
              </label>
            ) : null}
          </Callout>
        ) : null}
        <Field label="操作者" htmlFor="action-actor">
          <Input id="action-actor" data-autofocus value={actor} onChange={(event) => setActor(event.target.value)} maxLength={200} required />
        </Field>
        <Field label="理由" htmlFor="action-reason">
          <Textarea id="action-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={4} maxLength={2_000} required />
        </Field>
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </form>
    </Modal>
  );
}
