import { useEffect } from "react";
import { Check, History, Pause, X } from "lucide-react";
import { Button } from "../../../ui/button";
import { Callout } from "../../../ui/form";
import { PlanEditor, type EditablePlan } from "../../PlanEditor";
import type { RunState } from "../../../types";
import { submitLabel, submitPayload, type DialogMode, type DialogView } from "./model";
import type { SubmitInput } from "./model";

export const FORM_ID = "run-action-form";

type Seeders = {
  setActor(value: string): void;
  setReason(value: string): void;
  setAckIncomplete(value: boolean): void;
  setEditing(value: boolean): void;
  setDraft(value: EditablePlan | undefined): void;
};

/** The form is re-seeded when the dialog opens, not when the run refreshes under it. */
export function useSeedOnOpen(
  mode: DialogMode,
  approvalId: string | undefined,
  run: RunState | undefined,
  seed: Seeders,
): void {
  const { setActor, setReason, setAckIncomplete, setEditing, setDraft } = seed;
  useEffect(() => {
    if (!mode) return;
    setActor("");
    setReason("");
    setAckIncomplete(false);
    setEditing(false);
    setDraft(run?.plan ? structuredClone(run.plan) : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, approvalId]);
}

export function DialogFooter({
  mode,
  busy,
  ready,
  blocked,
  edited,
  formId,
  onClose,
  onReject,
}: {
  mode: DialogMode;
  busy: boolean;
  ready: boolean;
  blocked: boolean;
  edited: boolean;
  formId: string;
  onClose(): void;
  onReject(): void;
}) {
  return (
    <>
      <Button onClick={onClose}>取消</Button>
      {mode === "approval" && (
        <Button variant="danger" disabled={busy || !ready} onClick={onReject}>
          <X />拒绝
        </Button>
      )}
      <Button type="submit" form={formId} variant="primary" disabled={busy || !ready || blocked}>
        <SubmitIcon mode={mode} />
        {submitLabel(mode, edited, busy)}
      </Button>
    </>
  );
}

function SubmitIcon({ mode }: { mode: DialogMode }) {
  if (mode === "approval") return <Check />;
  if (mode === "pause") return <Pause />;
  return <History />;
}

export function PlanSection({
  draft,
  editing,
  busy,
  problem,
  onChange,
  onToggle,
}: {
  draft: EditablePlan;
  editing: boolean;
  busy: boolean;
  problem: string | undefined;
  onChange(next: EditablePlan): void;
  onToggle(): void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={editing ? "secondary" : "ghost"}
        size="sm"
        className="self-start"
        aria-expanded={editing}
        onClick={onToggle}
      >
        {editing ? "收起计划编辑" : "编辑计划后批准"}
      </Button>
      {editing ? <PlanEditor plan={draft} onChange={onChange} disabled={busy} /> : null}
      {problem ? (
        <Callout tone="danger" role="alert">
          {problem}
        </Callout>
      ) : null}
    </div>
  );
}

/** One submit path for approve, reject and resume. */
export function useSubmit(input: {
  actor: string;
  reason: string;
  draft: EditablePlan | undefined;
  view: DialogView;
  onSubmit(payload: SubmitInput): Promise<void>;
}): (decision?: "approved" | "rejected") => Promise<void> {
  const { actor, reason, draft, view, onSubmit } = input;
  return async (decision) => {
    const payload = submitPayload({
      ...(decision ? { decision } : {}),
      actor,
      reason,
      ...(decision === "approved" && view.edited && draft ? { plan: draft } : {}),
    });
    if (!payload) return;
    if (decision === "approved" && view.approveBlocked) return;
    await onSubmit(payload);
  };
}
