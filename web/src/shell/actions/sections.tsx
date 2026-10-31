import { Ban, Check, Copy, ExternalLink, GitPullRequest, History, Pause, RotateCcw, ShieldCheck } from "lucide-react";
import type { ApprovalRequest, RunState } from "../../types";
import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";
import { canPublish, canResume, canRetry, isActiveRun, pruneLabel, retryHint, retryLabel } from "./model";

export function PullRequestLink({
  run,
  copied,
  onCopy,
}: {
  run: RunState;
  copied: boolean;
  onCopy(): void;
}) {
  const url = run.pullRequestUrl;
  if (!url) return null;
  return (
    <span className="bd mr-1 inline-flex h-8 items-center overflow-hidden rounded-md bg-surface">
      <Tooltip label="点击复制 PR 链接">
        <button
          type="button"
          aria-label="复制 PR 链接"
          onClick={onCopy}
          className="inline-flex h-full cursor-pointer items-center gap-1.5 px-2.5 text-sm font-medium text-ink-2 hover:bg-surface-3 focus-ring"
        >
          <GitPullRequest className="size-3.5" />
          {pruneLabel(run)}
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3 text-muted" />}
        </button>
      </Tooltip>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="在新标签页打开 PR"
        title="在新标签页打开 PR"
        className="bd-l grid h-full w-8 place-items-center text-muted hover:bg-surface-3 hover:text-ink focus-ring"
      >
        <ExternalLink className="size-3.5" />
      </a>
    </span>
  );
}

export function ApprovalButton({
  approval,
  busy,
  onReviewApproval,
}: {
  approval: ApprovalRequest | undefined;
  busy: boolean;
  onReviewApproval(approval: ApprovalRequest): void;
}) {
  if (!approval) return null;
  return (
    <Button variant="warning" disabled={busy} title="处理审批" onClick={() => onReviewApproval(approval)}>
      <ShieldCheck />
      处理审批
    </Button>
  );
}

export function RunControlButtons({
  run,
  busy,
  onResume,
  onPublish,
  onPause,
  onCancel,
  onRetry,
}: {
  run: RunState;
  busy: boolean;
  onResume(): void;
  onPublish(): void;
  onPause(): void;
  onCancel(): void;
  onRetry(): void;
}) {
  return (
    <>
      {canResume(run) && (
        <Button variant="primary" disabled={busy} title="从最近任务边界检查点继续（推荐）" onClick={onResume}>
          <History />
          从检查点继续
        </Button>
      )}
      {canPublish(run) && (
        <Button variant="primary" disabled={busy} title="推送集成分支并创建 Pull Request" onClick={onPublish}>
          <GitPullRequest />
          发布
        </Button>
      )}
      {isActiveRun(run) && (
        <>
          <Button disabled={busy} title="暂停运行（保留检查点，稍后可恢复）" onClick={onPause}>
            <Pause />
            暂停
          </Button>
          <CancelButton busy={busy} onCancel={onCancel} />
        </>
      )}
      {canRetry(run) && (
        <Button disabled={busy} title={retryHint(run)} onClick={onRetry}>
          <RotateCcw />
          {retryLabel(run)}
        </Button>
      )}
    </>
  );
}

function CancelButton({ busy, onCancel }: { busy: boolean; onCancel(): void }) {
  return (
    <Button
      variant="ghost"
      disabled={busy}
      title="取消运行"
      onClick={onCancel}
      className="text-danger-ink hover:bg-danger-soft hover:text-danger-ink"
    >
      <Ban />
      取消
    </Button>
  );
}
