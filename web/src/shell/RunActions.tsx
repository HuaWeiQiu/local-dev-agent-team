import { useState } from "react";
import type { ApprovalRequest, RunState } from "../types";
import { copyText } from "./actions/copy";
import { ApprovalButton, PullRequestLink, RunControlButtons } from "./actions/sections";

const COPY_FEEDBACK_MS = 1_600;

interface RunActionsProps {
  run: RunState;
  busy: boolean;
  pendingApproval: ApprovalRequest | undefined;
  onReviewApproval(approval: ApprovalRequest): void;
  onResume(): void;
  onPublish(): void;
  onPause(): void;
  onCancel(): void;
  onRetry(): void;
}

/** Context actions for the open run. Which ones show is a pure function of status. */
export function RunActions({
  run,
  busy,
  pendingApproval,
  onReviewApproval,
  onResume,
  onPublish,
  onPause,
  onCancel,
  onRetry,
}: RunActionsProps) {
  const { copied, copy } = useCopyFeedback(run.pullRequestUrl);
  return (
    <>
      <PullRequestLink run={run} copied={copied} onCopy={copy} />
      <ApprovalButton approval={pendingApproval} busy={busy} onReviewApproval={onReviewApproval} />
      <RunControlButtons
        run={run}
        busy={busy}
        onResume={onResume}
        onPublish={onPublish}
        onPause={onPause}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    </>
  );
}

/** A successful copy shows a tick for a moment, then goes back to the icon. */
function useCopyFeedback(url: string | undefined): { copied: boolean; copy(): void } {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    if (!url) return;
    void copyText(url).then((ok) => {
      setCopied(ok);
      if (ok) window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  };
  return { copied, copy };
}
