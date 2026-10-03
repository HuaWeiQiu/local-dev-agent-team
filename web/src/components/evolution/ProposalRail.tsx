import { ChevronRight, GitCompareArrows, Plus, RefreshCw, Search } from "lucide-react";
import type { EvolutionFilter } from "../../evolution";
import { proposalStatusLabel, proposalStatusTone, proposalTarget, proposalTitle } from "../../evolution";
import type { EvolutionProposal } from "../../types";
import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import { Input, Select } from "../../ui/form";
import { normalizeTone, StatusDot } from "../../ui/status";
import { ActionButton, Kicker } from "./controls";
import { formatDate } from "./format";
import { KindIcon } from "./KindIcon";

interface ProposalRailProps {
  proposals: EvolutionProposal[];
  totalCount: number;
  selectedId: string | undefined;
  query: string;
  filter: EvolutionFilter;
  busy: boolean;
  loading: boolean;
  createDisabled: boolean;
  singlePane: boolean;
  className?: string;
  onQueryChange(value: string): void;
  onFilterChange(value: EvolutionFilter): void;
  onSelect(id: string): void;
  onCreate(): void;
  onRefresh(): void;
}

const filterOptions: Array<{ value: EvolutionFilter; label: string }> = [
  { value: "open", label: "待处理" },
  { value: "all", label: "全部" },
  { value: "archived", label: "已归档" },
  { value: "proposed", label: "待预检" },
  { value: "evaluated", label: "已预检" },
  { value: "promoted", label: "已晋升" },
  { value: "rejected", label: "已拒绝" },
  { value: "rolled-back", label: "已回滚" },
];

export function ProposalRail({
  proposals,
  totalCount,
  selectedId,
  query,
  filter,
  busy,
  loading,
  createDisabled,
  singlePane,
  className,
  onQueryChange,
  onFilterChange,
  onSelect,
  onCreate,
  onRefresh,
}: ProposalRailProps) {
  return (
    <aside className={cn("flex min-w-0 flex-col bg-surface-2", singlePane ? "flex-1" : "bd-r min-h-0", className)}>
      <header className="bd-b flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <Kicker>受控演进</Kicker>
          <h1 className="m-0 mt-1.5 text-base font-semibold leading-none tracking-tight text-ink">演进候选</h1>
        </div>
        <ActionButton variant="ghost" size="icon" onClick={onRefresh} disabled={loading || busy} aria-label="刷新演进状态" title="刷新">
          <RefreshCw className={cn(loading && "animate-spin")} />
        </ActionButton>
        <ActionButton variant="primary" onClick={onCreate} disabled={createDisabled} title="新建候选">
          <Plus />
          <span>新建</span>
        </ActionButton>
      </header>

      <div className="bd-b flex gap-2 px-3 py-2.5">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            disabled={busy}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索候选"
            aria-label="搜索候选"
            className="h-8 pl-8"
          />
        </div>
        <div className="w-[104px] shrink-0">
          <Select value={filter} disabled={busy} onChange={(event) => onFilterChange(event.target.value as EvolutionFilter)} aria-label="候选状态筛选">
            {filterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </div>
      </div>

      <div className={cn(!singlePane && "scroll-thin min-h-0 flex-1 overflow-y-auto")}>
        {proposals.length > 0 ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {proposals.map((proposal) => {
              const selected = proposal.id === selectedId;
              const tone = normalizeTone(proposalStatusTone(proposal));
              return (
                <li key={proposal.id} className="bd-b">
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    disabled={busy}
                    onClick={() => onSelect(proposal.id)}
                    className={cn(
                      "grid w-full cursor-pointer grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 border-0 bg-transparent px-4 py-3 text-left text-ink transition-colors hover:bg-surface focus-ring disabled:cursor-wait disabled:opacity-70",
                      singlePane && "grid-cols-[2rem_minmax(0,1fr)_auto_1rem]",
                      selected && "bg-surface shadow-[inset_2px_0_0_var(--accent)]",
                    )}
                  >
                    <KindIcon kind={proposal.candidate.kind} className="size-8" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <strong className="truncate text-sm font-semibold leading-snug">{proposalTitle(proposal)}</strong>
                      <small className="truncate text-xs text-muted">{proposalTarget(proposal)}</small>
                      <time className="text-2xs text-muted">{formatDate(proposal.createdAt)}</time>
                    </span>
                    <Badge tone={tone} className="mt-0.5">
                      <StatusDot tone={tone} pulse={tone === "active"} className="size-1.5" />
                      {proposalStatusLabel(proposal)}
                    </Badge>
                    {singlePane && <ChevronRight aria-hidden className="mt-1 size-4 text-muted" />}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-surface-3 text-muted [&_svg]:size-5">
              <GitCompareArrows />
            </span>
            <div className="flex flex-col gap-1">
              <strong className="text-sm font-medium text-ink-2">
                {totalCount > 0 ? "没有符合条件的候选" : "还没有演进候选"}
              </strong>
              <span className="text-xs text-muted">
                {totalCount > 0 ? "调整搜索词或状态筛选后再试" : "为执行策略或角色提示词创建第一个候选"}
              </span>
            </div>
            {totalCount === 0 && (
              <ActionButton onClick={onCreate} disabled={createDisabled}><Plus />新建候选</ActionButton>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
