import { ArrowUp, Search, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { BoardLane } from "../../board";
import { strategyDisplayName } from "../../presentation";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Kbd } from "../../ui/kbd";
import type { PublicConfig } from "../../types";

export function GoalComposer({
  goal,
  strategies,
  activeStrategy,
  config,
  busy,
  onGoal,
  onStrategy,
  onSubmit,
  onKeyDown,
}: {
  goal: string;
  strategies: string[];
  activeStrategy: string | undefined;
  config: PublicConfig | undefined;
  busy: boolean;
  onGoal(value: string): void;
  onStrategy(name: string): void;
  onSubmit(): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
}) {
  return (
    <div className="bd rounded-lg bg-surface p-1">
      <label htmlFor="board-goal" className="sr-only">
        描述目标
      </label>
      <textarea
        id="board-goal"
        value={goal}
        rows={2}
        onChange={(event) => onGoal(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="描述你想让团队完成的目标，例如：为订单列表增加 CSV 导出…"
        className="block min-h-[68px] w-full resize-none rounded-lg border-0 bg-transparent px-3.5 pb-1 pt-3 text-base leading-relaxed text-ink outline-none placeholder:text-muted"
      />
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        <StrategyPicker strategies={strategies} active={activeStrategy} onPick={onStrategy} />
        <span className="ml-auto hidden items-center gap-1 text-2xs text-muted sm:flex">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>继续
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={!goal.trim() || !config || busy}
          onClick={onSubmit}
          aria-label="配置并启动"
        >
          配置并启动
          <ArrowUp className="rotate-45" />
        </Button>
      </div>
    </div>
  );
}

function StrategyPicker({
  strategies,
  active,
  onPick,
}: {
  strategies: string[];
  active: string | undefined;
  onPick(name: string): void;
}) {
  return (
    <div role="radiogroup" aria-label="执行策略" className="flex items-center gap-1">
      {strategies.map((name) => (
        <button
          key={name}
          role="radio"
          aria-checked={name === active}
          type="button"
          onClick={() => onPick(name)}
          className={cn(
            "h-6 cursor-pointer rounded-full px-2.5 text-xs font-medium transition-colors focus-ring",
            name === active ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-surface-3 hover:text-ink",
          )}
        >
          {strategyDisplayName(name)}
        </button>
      ))}
    </div>
  );
}

export function BoardToolbar({
  total,
  query,
  busy,
  onQuery,
  onCleanup,
}: {
  total: number;
  query: string;
  busy: boolean;
  onQuery(value: string): void;
  onCleanup(): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="m-0 text-sm font-semibold text-ink">运行</h2>
      <span className="text-xs text-muted">共 {total} 个</span>
      <div className="bd ml-auto flex h-8 w-full max-w-64 items-center gap-2 rounded-md bg-surface px-2.5 focus-within:shadow-[var(--focus-ring)]">
        <Search className="size-3.5 shrink-0 text-muted" />
        <input
          aria-label="搜索运行"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索目标、状态…"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
        />
      </div>
      <Button size="md" onClick={onCleanup} disabled={busy} aria-label="清理历史" title="清理历史">
        <Trash2 />
        清理历史
      </Button>
    </div>
  );
}

export const BOARD_LANES: BoardLane[] = ["attention", "active", "done"];
