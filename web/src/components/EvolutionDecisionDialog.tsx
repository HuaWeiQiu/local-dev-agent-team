import { Check, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { EvolutionPreviewResponse } from "../types";
import { Modal } from "../ui/dialog";
import { Callout, Field, Textarea } from "../ui/form";
import { ActionButton } from "./evolution/controls";
import {
  actionLabel,
  copyFor,
  dialogWidth,
  isDestructive,
  submitDisabled,
  trimmedReason,
} from "./evolution/decision/model";
import {
  AdoptNotice,
  DeleteNotice,
  PreviewNotice,
  PreviewPanes,
} from "./evolution/decision/sections";
import { useRestoreFocus } from "./evolution/useRestoreFocus";

export type EvolutionDecision = {
  mode: "promote" | "rollback" | "reject" | "adopt" | "delete";
  proposalId: string;
  commandId: string;
  preview?: EvolutionPreviewResponse;
  submittedReason?: string;
};

interface EvolutionDecisionDialogProps {
  decision: EvolutionDecision | undefined;
  busy: boolean;
  error?: string;
  onClose(): void;
  onSubmit(reason: string): Promise<void>;
}

const formId = "evolution-decision-form";

export function EvolutionDecisionDialog({
  decision,
  busy,
  error,
  onClose,
  onSubmit,
}: EvolutionDecisionDialogProps) {
  const [reason, setReason] = useState("");
  useRestoreFocus(decision !== undefined);
  useResetReason(decision, setReason);

  const copy = copyFor(decision);
  const preview: EvolutionPreviewResponse | undefined = decision?.preview;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = trimmedReason(reason);
    if (trimmed) void onSubmit(trimmed);
  };

  return (
    <Modal
      open={decision !== undefined}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      locked={busy}
      title={copy.title}
      description={copy.description}
      className={dialogWidth(preview)}
      footer={
        <DecisionFooter
          decision={decision}
          busy={busy}
          canSubmit={!submitDisabled(decision, busy, reason)}
          onClose={onClose}
        />
      }
    >
      {decision && (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          <DecisionBody decision={decision} />
          <Field label="决定理由" htmlFor="evolution-decision-reason">
            <Textarea
              id="evolution-decision-reason"
              data-autofocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              maxLength={2_000}
              required
              disabled={decision.submittedReason !== undefined}
            />
          </Field>
          {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
        </form>
      )}
    </Modal>
  );
}

/** A different command opens a fresh dialog: clear the previous reason. */
function useResetReason(
  decision: EvolutionDecision | undefined,
  setReason: (value: string) => void,
): void {
  useEffect(() => {
    if (decision) setReason("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision?.commandId]);
}

function DecisionBody({ decision }: { decision: EvolutionDecision }): ReactNode {
  if (decision.preview) {
    return (
      <>
        <PreviewNotice />
        <PreviewPanes decision={decision} preview={decision.preview} />
      </>
    );
  }
  if (decision.mode === "adopt") return <AdoptNotice />;
  if (decision.mode === "delete") return <DeleteNotice />;
  return null;
}

function DecisionFooter({
  decision,
  busy,
  canSubmit,
  onClose,
}: {
  decision: EvolutionDecision | undefined;
  busy: boolean;
  canSubmit: boolean;
  onClose(): void;
}): ReactNode {
  return (
    <>
      <ActionButton onClick={onClose} disabled={busy}>取消</ActionButton>
      <ActionButton
        type="submit"
        form={formId}
        variant={isDestructive(decision?.mode) ? "danger" : "primary"}
        disabled={!canSubmit}
      >
        <DecisionIcon decision={decision} />
        {actionLabel(decision, busy)}
      </ActionButton>
    </>
  );
}

function DecisionIcon({ decision }: { decision: EvolutionDecision | undefined }): ReactNode {
  if (decision?.mode === "rollback") return <RotateCcw />;
  if (decision?.mode === "reject") return <X />;
  if (decision?.mode === "delete") return <Trash2 />;
  return <Check />;
}
