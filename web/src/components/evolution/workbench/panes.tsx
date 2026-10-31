import { GitCompareArrows, LockKeyhole, RefreshCw } from "lucide-react";
import { CircleAlert } from "lucide-react";
import type { EvolutionSnapshot } from "../../../types";
import { cn } from "../../../ui/cn";
import { ActionPanel } from "../../evolution/ActionPanel";
import { ActionButton, Kicker } from "../../evolution/controls";
import { ProposalDetail } from "../../evolution/ProposalDetail";
import { ProposalRail } from "../../evolution/ProposalRail";
import { ScopeNote, TargetMetadata } from "../../evolution/TargetNotes";
import type { EvolutionWorkbenchModel } from "./useEvolutionWorkbench";
import { lockReason } from "./model";

/** Loading / unrecoverable states share one shell. */
export function EvolutionUnavailable({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | undefined;
  onRetry(): void;
}) {
  return (
    <section aria-label="演进工作台" className="grid h-full place-items-center bg-background px-6">
      {loading ? (
        <div role="status" className="flex flex-col items-center gap-3 text-sm text-muted">
          <RefreshCw className="size-6 animate-spin text-accent" />
          <span>正在加载演进控制面</span>
        </div>
      ) : (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <span aria-hidden className="grid size-11 place-items-center rounded-xl bg-danger-soft text-danger-ink [&_svg]:size-5">
            <LockKeyhole />
          </span>
          <strong className="text-base font-semibold text-ink">无法进入演进工作台</strong>
          <span className="break-words text-sm leading-relaxed text-muted">{error}</span>
          <ActionButton onClick={onRetry}>
            <RefreshCw />
            重试
          </ActionButton>
        </div>
      )}
    </section>
  );
}

export function LockBanner({ snapshot }: { snapshot: EvolutionSnapshot }) {
  if (!snapshot.recoveryRequired && !snapshot.pendingOperation) return null;
  return (
    <div className="bd-b shrink-0 bg-warning-soft px-4 py-2.5 md:px-6">
      <div role="alert" className="flex items-start gap-2.5 text-warning-ink">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <strong className="text-xs font-semibold">演进操作已锁定</strong>
          <span className="text-xs">{lockReason(snapshot)}</span>
        </div>
      </div>
    </div>
  );
}

export function EvolutionPanes({
  model,
  twoPane,
  wide,
}: {
  model: EvolutionWorkbenchModel;
  twoPane: boolean;
  wide: boolean;
}) {
  return (
    <div className={cn("flex flex-1", twoPane ? "min-h-0 flex-row" : "flex-col")}>
      <ProposalRail
        proposals={model.proposals}
        totalCount={model.snapshot?.proposals.length ?? 0}
        selectedId={model.selectedId}
        query={model.query}
        filter={model.filter}
        busy={model.busy}
        loading={model.loading}
        createDisabled={model.locked}
        singlePane={!twoPane}
        className={cn(twoPane && "w-[300px] shrink-0 xl:w-[320px]", !twoPane && model.selected && "hidden")}
        onQueryChange={model.setQuery}
        onFilterChange={model.setFilter}
        onSelect={model.selectProposal}
        onCreate={() => {
          model.setCreating(true);
          model.setDialogError(undefined);
        }}
        onRefresh={() => void model.refresh().catch(() => undefined)}
      />
      <DetailArea model={model} twoPane={twoPane} wide={wide} />
      {wide && <AsidePanel model={model} />}
    </div>
  );
}

function DetailArea({
  model,
  twoPane,
  wide,
}: {
  model: EvolutionWorkbenchModel;
  twoPane: boolean;
  wide: boolean;
}) {
  if (!model.selected) {
    return twoPane ? <EmptyDetail /> : null;
  }
  const selected = model.selected;
  return (
    <ProposalDetail
      proposal={selected}
      audit={model.audit}
      completed={model.completed}
      tab={model.tab}
      scrollable={twoPane}
      actions={wide ? null : <PanelActions model={model} compact />}
      notes={wide ? null : (
        <div className="flex flex-col gap-3">
          <ScopeNote proposal={selected} />
          <TargetMetadata
            proposal={selected}
            catalogRevision={model.snapshot?.catalogRevision ?? 0}
          />
        </div>
      )}
      onTabChange={model.setTab}
      onBack={twoPane ? undefined : () => model.setSelectedId(undefined)}
    />
  );
}

function EmptyDetail() {
  return (
    <main className="grid min-w-0 flex-1 place-items-center bg-background p-6">
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <span aria-hidden className="grid size-11 place-items-center rounded-xl bg-surface-3 text-muted [&_svg]:size-5">
          <GitCompareArrows />
        </span>
        <strong className="text-sm font-semibold text-ink-2">选择一个候选</strong>
        <span className="text-xs leading-relaxed text-muted">查看变更、结构预检与审计记录</span>
      </div>
    </main>
  );
}

function AsidePanel({ model }: { model: EvolutionWorkbenchModel }) {
  return (
    <aside className="bd-l scroll-thin flex w-[320px] shrink-0 flex-col gap-3 overflow-y-auto bg-surface-2 p-4">
      <div>
        <Kicker>操作</Kicker>
        <h2 className="m-0 mt-1.5 text-base font-semibold leading-none tracking-tight text-ink">下一步</h2>
      </div>
      {model.selected ? (
        <PanelActions model={model} compact={false} />
      ) : (
        <p className="m-0 py-4 text-xs text-muted">选择候选后显示可执行操作</p>
      )}
      <ScopeNote proposal={model.selected} />
      {model.selected && (
        <TargetMetadata
          proposal={model.selected}
          catalogRevision={model.snapshot?.catalogRevision ?? 0}
        />
      )}
    </aside>
  );
}

function PanelActions({
  model,
  compact,
}: {
  model: EvolutionWorkbenchModel;
  compact: boolean;
}) {
  if (!model.selected) return null;
  return (
    <ActionPanel
      proposal={model.selected}
      locked={model.locked}
      busy={model.busy}
      compact={compact}
      onEvaluate={() => void model.evaluate()}
      onPromote={() => void model.openPreview("promote")}
      onRollback={() => void model.openPreview("rollback")}
      onReject={() => model.openReasonDecision("reject")}
      onAdopt={() => model.openReasonDecision("adopt")}
      onArchive={() => void model.archive()}
      onUnarchive={() => void model.unarchive()}
      onDelete={() => model.openDeleteDecision()}
    />
  );
}
