import { useState, type FormEvent } from "react";
import type { ApprovalRequest, RunState } from "../types";
import { Callout } from "../ui/form";
import { Modal } from "../ui/dialog";
import { CompletenessPanel, IdentityFields, ApprovalBanner } from "./run/action-dialog/sections";
import {
  DialogFooter,
  FORM_ID,
  PlanSection,
  useSeedOnOpen,
  useSubmit,
} from "./run/action-dialog/dialog";
import {
  dialogDescription,
  dialogTitle,
  dialogView,
} from "./run/action-dialog/model";
import type { EditablePlan } from "./PlanEditor";

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
    plan?: EditablePlan;
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditablePlan>();

  useSeedOnOpen(mode, approval?.id, run, { setActor, setReason, setAckIncomplete, setEditing, setDraft });

  const view = dialogView({ mode, approval, run, draft, editing, acknowledged: ackIncomplete, actor, reason });

  const execute = useSubmit({ actor, reason, draft, view, onSubmit });

  return (
    <Modal
      open={Boolean(mode)}
      onOpenChange={(next) => !next && onClose()}
      title={dialogTitle(mode, approval)}
      description={dialogDescription(mode)}
      className="w-[min(540px,calc(100vw-32px))]"
      footer={
        <DialogFooter
          mode={mode}
          busy={busy}
          ready={view.ready}
          blocked={view.approveBlocked}
          edited={view.edited}
          formId={FORM_ID}
          onClose={onClose}
          onReject={() => void execute("rejected")}
        />
      }
    >
      <form
        id={FORM_ID}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void execute(mode === "approval" ? "approved" : undefined);
        }}
        className="flex flex-col gap-4"
      >
        {approval && <ApprovalBanner approval={approval} />}
        {view.completeness && (
          <CompletenessPanel
            completeness={view.completeness}
            acknowledged={ackIncomplete}
            onAcknowledge={setAckIncomplete}
          />
        )}
        {view.editable && draft ? (
          <PlanSection
            draft={draft}
            editing={editing}
            busy={busy}
            problem={view.draftProblem}
            onChange={setDraft}
            onToggle={() => setEditing((current) => !current)}
          />
        ) : null}
        <IdentityFields actor={actor} reason={reason} onActor={setActor} onReason={setReason} />
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
      </form>
    </Modal>
  );
}
