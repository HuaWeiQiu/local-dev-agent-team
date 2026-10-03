import { Ban, Check, Copy, ExternalLink, GitPullRequest, History, Pause, RotateCcw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { activeRunStatuses } from "../presentation";
import type { ApprovalRequest, RunState } from "../types";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

const retryableStatuses = new Set(["blocked", "cancelled", "interrupted"]);

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
export function RunActions({ run, busy, pendingApproval, onReviewApproval, onResume, onPublish, onPause, onCancel, onRetry }: RunActionsProps) {
  const [copied, setCopied] = useState(false);
  const active = activeRunStatuses.has(run.status);
  return (
    <>
      {run.pullRequestUrl && (
        <span className="bd mr-1 inline-flex h-8 items-center overflow-hidden rounded-md bg-surface">
          <Tooltip label="点击复制 PR 链接">
            <button
              type="button"
              aria-label="复制 PR 链接"
              onClick={() => {
                void copyText(run.pullRequestUrl!).then((ok) => {
                  setCopied(ok);
                  if (ok) window.setTimeout(() => setCopied(false), 1_600);
                });
              }}
              className="inline-flex h-full cursor-pointer items-center gap-1.5 px-2.5 text-sm font-medium text-ink-2 hover:bg-surface-3 focus-ring"
            >
              <GitPullRequest className="size-3.5" />
              PR #{run.pullRequestNumber ?? ""}
              {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3 text-muted" />}
            </button>
          </Tooltip>
          <a
            href={run.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="在新标签页打开 PR"
            title="在新标签页打开 PR"
            className="bd-l grid h-full w-8 place-items-center text-muted hover:bg-surface-3 hover:text-ink focus-ring"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </span>
      )}
      {pendingApproval && (
        <Button variant="warning" disabled={busy} title="处理审批" onClick={() => onReviewApproval(pendingApproval)}>
          <ShieldCheck />处理审批
        </Button>
      )}
      {run.status === "interrupted" && run.checkpoints?.length ? (
        <Button variant="primary" disabled={busy} title="从最近任务边界检查点继续（推荐）" onClick={onResume}>
          <History />从检查点继续
        </Button>
      ) : null}
      {["ready-to-merge", "ci-failed"].includes(run.status) && (
        <Button variant="primary" disabled={busy} title="推送集成分支并创建 Pull Request" onClick={onPublish}>
          <GitPullRequest />发布
        </Button>
      )}
      {active && (
        <Button disabled={busy} title="暂停运行（保留检查点，稍后可恢复）" onClick={onPause}>
          <Pause />暂停
        </Button>
      )}
      {active && (
        <Button variant="ghost" disabled={busy} title="取消运行" onClick={onCancel} className="text-danger-ink hover:bg-danger-soft hover:text-danger-ink">
          <Ban />取消
        </Button>
      )}
      {retryableStatuses.has(run.status) && (
        <Button
          disabled={busy}
          title={run.status === "interrupted" ? "放弃检查点，用同一目标新开一条 run" : "以同一目标新开一条关联 run"}
          onClick={onRetry}
        >
          <RotateCcw />{run.status === "interrupted" ? "重新开始" : "重试为新运行"}
        </Button>
      )}
    </>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (non-secure contexts, some webviews)
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
