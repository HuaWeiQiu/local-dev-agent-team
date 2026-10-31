import { Plus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRestoreFocus } from "./evolution/useRestoreFocus";
import type { EvolutionSnapshot, PublicConfig, StrategyBlueprintDefinition } from "../types";
import { Modal } from "../ui/dialog";
import { Callout } from "../ui/form";
import { ActionButton } from "./evolution/controls";
import { KindSwitch, PromptFields, StrategyFields } from "./evolution/proposal/sections";
import {
  canSubmitDraft,
  draftFromSource,
  initialDraft,
  proposalFromDraft,
  strategyNamesOf,
  type Draft,
} from "./evolution/proposal/model";

/** What the dialog hands back to the workbench. */
export type EvolutionProposalInput =
  | { kind: "strategy"; name: string; definition: StrategyBlueprintDefinition; commandId: string }
  | { kind: "prompt"; role: string; content: string; commandId: string };

const formId = "evolution-proposal-form";

interface EvolutionProposalDialogProps {
  open: boolean;
  config: PublicConfig;
  snapshot: EvolutionSnapshot;
  busy: boolean;
  error?: string;
  onClose(): void;
  onSubmit(input: EvolutionProposalInput): Promise<void>;
}

export function EvolutionProposalDialog({
  open,
  config,
  snapshot,
  busy,
  error,
  onClose,
  onSubmit,
}: EvolutionProposalDialogProps) {
  useRestoreFocus(open);
  const strategyNames = useMemo(() => strategyNamesOf(config), [config]);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(config, snapshot.promptRoles));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(config, snapshot.promptRoles));
    setSubmitted(false);
  }, [config, open, snapshot.promptRoles]);

  const frozen = busy || submitted;
  const canSubmit = canSubmitDraft(draft, config);

  const change = (patch: Partial<Draft>): void => {
    setDraft((current) => applyPatch(current, patch, config));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitted(true);
    const proposal = proposalFromDraft(draft, config);
    if (proposal) void onSubmit(proposal);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (closesDialog(next, busy)) onClose();
      }}
      locked={busy}
      title="新建演进候选"
      description="候选需先通过服务端结构预检，再由人工确认精确变更后才会生效。"
      className="w-[min(580px,calc(100vw-32px))] text-sm"
      footer={<DialogFooter busy={busy} submitted={submitted} canSubmit={canSubmit} onClose={onClose} />}
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        <KindSwitch
          kind={draft.kind}
          frozen={frozen}
          promptsAvailable={snapshot.promptRoles.length > 0}
          onChange={(kind) => change({ kind })}
        />
        <ProposalFields
          draft={draft}
          snapshot={snapshot}
          strategyNames={strategyNames}
          frozen={frozen}
          onChange={change}
        />
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      </form>
    </Modal>
  );
}

/** A close request only wins while no submission is in flight. */
export function closesDialog(nextOpen: boolean, busy: boolean): boolean {
  return !nextOpen && !busy;
}

/** Footer copy: busy wins over "retry the previous candidate". */
export function submitLabel(busy: boolean, submitted: boolean): string {
  if (busy) return "提交中";
  return submitted ? "重试原候选" : "创建候选";
}

function DialogFooter({
  busy,
  submitted,
  canSubmit,
  onClose,
}: {
  busy: boolean;
  submitted: boolean;
  canSubmit: boolean;
  onClose(): void;
}) {
  return (
    <>
      <ActionButton onClick={onClose} disabled={busy}>取消</ActionButton>
      <ActionButton type="submit" form={formId} variant="primary" disabled={busy || !canSubmit}>
        <Plus />
        {submitLabel(busy, submitted)}
      </ActionButton>
    </>
  );
}

function ProposalFields({
  draft,
  snapshot,
  strategyNames,
  frozen,
  onChange,
}: {
  draft: Draft;
  snapshot: EvolutionSnapshot;
  strategyNames: string[];
  frozen: boolean;
  onChange(patch: Partial<Draft>): void;
}) {
  if (draft.kind === "prompt") {
    return (
      <PromptFields
        draft={draft}
        promptRoles={snapshot.promptRoles}
        frozen={frozen}
        onChange={onChange}
      />
    );
  }
  return (
    <StrategyFields
      draft={draft}
      strategyNames={strategyNames}
      frozen={frozen}
      onChange={onChange}
    />
  );
}

/** Changing the source re-seats the strategy fields in the same tick. */
function applyPatch(current: Draft, patch: Partial<Draft>, config: PublicConfig): Draft {
  if (patch.sourceName) return { ...current, ...draftFromSource(config, patch.sourceName) };
  return { ...current, ...patch };
}
