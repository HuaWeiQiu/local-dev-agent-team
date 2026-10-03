import { BookMarked, FilterX, Search } from "lucide-react";
import { formatTimestamp, summarizeGoal } from "../../presentation";
import type { ExperienceEntry } from "../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Input, Select } from "../../ui/form";
import { filterOptions, scopeLabel, statusLabels, statusTone, type ExperienceFilter } from "./model";

interface ExperienceListProps {
  entries: ExperienceEntry[];
  total: number;
  selectedId: string | undefined;
  query: string;
  filter: ExperienceFilter;
  busy: boolean;
  onQueryChange(value: string): void;
  onFilterChange(value: ExperienceFilter): void;
  onSelect(id: string): void;
  onResetFilters(): void;
}

export function ExperienceList({
  entries,
  total,
  selectedId,
  query,
  filter,
  busy,
  onQueryChange,
  onFilterChange,
  onSelect,
  onResetFilters,
}: ExperienceListProps) {
  const filtered = Boolean(query.trim()) || filter !== "all";

  return (
    <aside className="bd-b flex max-h-[44dvh] min-h-0 flex-col bg-surface md:max-h-none md:border-b-0 md:bd-r">
      <div className="flex flex-col gap-2 p-3">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            disabled={busy}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索"
            aria-label="搜索经验"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select
              value={filter}
              disabled={busy}
              onChange={(event) => onFilterChange(event.target.value as ExperienceFilter)}
              aria-label="筛选"
            >
              {filterOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </div>
          <span className="shrink-0 text-2xs tabular-nums text-muted" aria-live="polite">
            {filtered ? `${entries.length} / ${total}` : `${total} 条`}
          </span>
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {entries.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {entries.map((entry) => {
              const selected = entry.id === selectedId;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect(entry.id)}
                    className={cn(
                      "bd flex w-full cursor-pointer flex-col gap-1.5 rounded-lg bg-surface p-3 text-left text-ink transition-colors hover:border-line-strong hover:bg-surface-2 focus-ring disabled:cursor-not-allowed disabled:opacity-60",
                      selected && "border-accent-line bg-accent-soft/50 hover:bg-accent-soft/50",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <Badge tone={statusTone[entry.status]}>{statusLabels[entry.status]}</Badge>
                      <span className="text-2xs text-muted">{scopeLabel(entry.scope)}</span>
                    </span>
                    <strong
                      title={entry.summary}
                      className="line-clamp-3 text-sm font-medium leading-snug text-ink"
                    >
                      {summarizeGoal(entry.summary, 56)}
                    </strong>
                    <small className="text-2xs text-muted">
                      命中 {entry.hitCount} · {formatTimestamp(entry.updatedAt)}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-muted">
            <span aria-hidden className="grid size-10 place-items-center rounded-full bg-surface-3">
              {filtered ? <FilterX className="size-4" /> : <BookMarked className="size-4" />}
            </span>
            <span className="text-sm text-ink-2">
              {total === 0 ? "暂无经验。跑完任务后会出现候选。" : "无匹配项"}
            </span>
            {total > 0 && filtered ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onResetFilters}>
                清除筛选
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
