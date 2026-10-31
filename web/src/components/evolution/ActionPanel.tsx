import {
  Archive,
  ArchiveRestore,
  Ban,
  CheckCircle2,
  CircleAlert,
  GitCompareArrows,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { EvolutionProposal } from "../../types";
import { Card } from "../../ui/card";
import { cn } from "../../ui/cn";
import { ActionButton } from "./controls";
import { actionKey, canDelete, failureDescription, failureTitle, isReviewable, type ActionKey } from "./action/model";

export interface ProposalActionHandlers {
  onEvaluate(): void;
  onPromote(): void;
  onRollback(): void;
  onReject(): void;
  onAdopt(): void;
  onArchive(): void;
  onUnarchive(): void;
  onDelete(): void;
}

interface ActionPanelProps extends ProposalActionHandlers {
  proposal: EvolutionProposal;
  locked: boolean;
  busy: boolean;
  compact: boolean;
}

type Emphasis = "accent" | "success" | "warning" | "neutral";

const emphasisClass: Record<Emphasis, string> = {
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success-ink",
  warning: "bg-warning-soft text-warning-ink",
  neutral: "bg-surface-3 text-muted",
};

export function ActionPanel({ proposal, locked, busy, compact, ...handlers }: ActionPanelProps) {
  const disabled = locked || busy;

  if (proposal.archivedAt !== undefined) {
    return (
      <Stack>
        <NextAction compact={compact} emphasis="neutral" icon={<Archive />} title="已归档" description="候选已从默认列表收起，审计记录完整保留。取消归档后可继续操作。">
          <ActionButton onClick={handlers.onUnarchive} disabled={disabled}><ArchiveRestore />取消归档</ActionButton>
          {canDelete(proposal) && (
            <ActionButton variant="danger" onClick={handlers.onDelete} disabled={disabled}><Trash2 />删除候选</ActionButton>
          )}
        </NextAction>
      </Stack>
    );
  }

  const main = statusAction(proposal, disabled, compact, handlers);
  const reviewable = isReviewable(proposal.status);
  return (
    <Stack>
      {main}
      {reviewable && (
        <NextAction compact={compact} emphasis="neutral" icon={<Archive />} title="归档候选" description="归档后从默认列表收起，审计记录保留，可随时取消归档。">
          <ActionButton onClick={handlers.onArchive} disabled={disabled}><Archive />归档</ActionButton>
          {canDelete(proposal) && (
            <ActionButton variant="danger" onClick={handlers.onDelete} disabled={disabled}><Trash2 />删除候选</ActionButton>
          )}
        </NextAction>
      )}
    </Stack>
  );
}

function statusAction(
  proposal: EvolutionProposal,
  disabled: boolean,
  compact: boolean,
  handlers: ProposalActionHandlers,
): ReactNode {
  const ctx = { proposal, disabled, compact, handlers };
  return ACTION_PANELS[actionKey(proposal)](ctx);
}

interface PanelContext {
  proposal: EvolutionProposal;
  disabled: boolean;
  compact: boolean;
  handlers: ProposalActionHandlers;
}

const ACTION_PANELS: Record<ActionKey, (ctx: PanelContext) => ReactNode> = {
  preflight: ({ compact, disabled, handlers }) => (
    <NextAction compact={compact} emphasis="accent" icon={<ShieldCheck />} title="运行结构预检" description="校验候选结构、信任边界和目标条件。">
      <ActionButton variant="primary" onClick={handlers.onEvaluate} disabled={disabled}><ShieldCheck />开始预检</ActionButton>
    </NextAction>
  ),
  "resume-preflight": ({ compact, disabled, handlers }) => (
    <NextAction compact={compact} emphasis="accent" icon={<RefreshCw />} title="继续结构预检" description="上次预检未完成，可以从当前候选安全重入。">
      <ActionButton variant="primary" onClick={handlers.onEvaluate} disabled={disabled}><RefreshCw />继续预检</ActionButton>
    </NextAction>
  ),
  "review-ready": ({ compact, disabled, handlers }) => (
    <NextAction compact={compact} emphasis="success" icon={<CheckCircle2 />} title="检查精确变更" description="先查看当前值与应用后的完整内容，再作人工决定。">
      <ActionButton variant="primary" onClick={handlers.onPromote} disabled={disabled}><GitCompareArrows />查看并应用</ActionButton>
      <ActionButton variant="danger" onClick={handlers.onReject} disabled={disabled}><Ban />拒绝候选</ActionButton>
    </NextAction>
  ),
  "auto-comparing": ({ compact }) => (
    <NextAction compact={compact} emphasis="accent" icon={<RefreshCw className="animate-spin" />} title="自动比较中" description="系统正在根据隔离运行结果完成本轮决定，请等待状态刷新。" />
  ),
  "preflight-failed": ({ proposal, compact, disabled, handlers }) => (
    <NextAction
      compact={compact}
      emphasis="warning"
      icon={<CircleAlert />}
      title={failureTitle(proposal)}
      description={failureDescription(proposal)}
    >
      <ActionButton variant="danger" onClick={handlers.onReject} disabled={disabled}><Ban />拒绝候选</ActionButton>
    </NextAction>
  ),
  rollback: ({ compact, disabled, handlers }) => (
    <NextAction compact={compact} emphasis="success" icon={<RotateCcw />} title="已受控应用" description="可以预览并恢复到应用前的精确目标。">
      <ActionButton onClick={handlers.onRollback} disabled={disabled}><RotateCcw />预览回滚</ActionButton>
    </NextAction>
  ),
  adopt: ({ compact, disabled, handlers }) => (
    <NextAction compact={compact} emphasis="warning" icon={<LockKeyhole />} title="登记旧版应用" description="仅当当前目标逐字匹配候选时，采纳现状并建立应用记录。">
      <ActionButton onClick={handlers.onAdopt} disabled={disabled}><ShieldCheck />采纳当前目标</ActionButton>
    </NextAction>
  ),
  closed: ({ compact }) => (
    <NextAction compact={compact} emphasis="neutral" icon={<CheckCircle2 />} title="流程已结束" description="该候选已进入只读审计状态。" />
  ),
};

function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>;
}

function NextAction({ icon, emphasis, title, description, compact, children }: {
  icon: ReactNode;
  emphasis: Emphasis;
  title: string;
  description: string;
  compact: boolean;
  children?: ReactNode;
}) {
  return (
    <Card className={cn("p-4", compact ? "flex flex-wrap items-center gap-x-4 gap-y-3" : "flex flex-col gap-4")}>
      <div className={cn("flex min-w-0 gap-3", compact ? "flex-1 basis-56 items-center" : "items-start")}>
        <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4", emphasisClass[emphasis])}>{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm font-semibold leading-snug text-ink">{title}</h3>
          <p className={cn("m-0 mt-1 text-xs leading-relaxed text-muted", compact && "max-sm:hidden")}>{description}</p>
        </div>
      </div>
      {children ? <div className={cn("flex gap-2", compact ? "flex-wrap" : "flex-col [&>button]:w-full")}>{children}</div> : null}
    </Card>
  );
}
