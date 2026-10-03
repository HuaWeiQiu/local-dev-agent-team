import { ArrowUp, CheckCircle2, Clock, Loader2, Search, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { boardLaneLabels, buildBoard, type BoardCard, type BoardLane } from "../board";
import { strategyDisplayName, summarizeGoal, humanizeFailure } from "../presentation";
import { formatRelative } from "../time";
import type { PublicConfig, RunStatus, RunSummary } from "../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Kbd } from "../ui/kbd";
import { RunStatusPill, StatusDot } from "../ui/status";

const deletableStatuses = new Set<RunStatus>(["completed", "cancelled", "blocked", "interrupted"]);

const sampleGoals = [
  "为订单列表增加 CSV 导出，支持按时间范围筛选",
  "把重复的表单校验逻辑抽成共享模块并补测试",
  "修复结算页在小屏幕下按钮被遮挡的问题",
];

interface BoardPageProps {
  runs: RunSummary[];
  config: PublicConfig | undefined;
  selectedRunId: string | undefined;
  busy: boolean;
  loading: boolean;
  demo: boolean;
  onOpenRun(runId: string): void;
  onCreate(goal?: string, strategy?: string): void;
  onCleanup(): void;
  onDeleteRun(runId: string): void;
}

const laneMeta: Record<BoardLane, { icon: typeof Clock; empty: string; dot: "warning" | "active" | "neutral" }> = {
  attention: { icon: TriangleAlert, empty: "没有等你处理的事项", dot: "warning" },
  active: { icon: Loader2, empty: "当前没有正在执行的运行", dot: "active" },
  done: { icon: CheckCircle2, empty: "还没有已结束的运行", dot: "neutral" },
};

export function BoardPage({ runs, config, selectedRunId, busy, loading, demo, onOpenRun, onCreate, onCleanup, onDeleteRun }: BoardPageProps) {
  const [query, setQuery] = useState("");
  const [goal, setGoal] = useState("");
  const strategies = config ? Object.keys(config.strategies.definitions) : [];
  const [strategy, setStrategy] = useState<string>();
  const activeStrategy = strategy ?? config?.strategies.default;

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return runs;
    return runs.filter((run) => [run.goal, run.id, run.status, run.strategy].some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [query, runs]);
  const board = useMemo(() => buildBoard(filtered), [filtered]);

  const submit = () => {
    if (!goal.trim() || !config) return;
    onCreate(goal.trim(), activeStrategy);
    setGoal("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  const empty = !loading && runs.length === 0;

  return (
    <section aria-label="运行工作台" className="scroll-thin mx-auto flex h-full w-full max-w-[1280px] flex-col gap-6 overflow-y-auto px-4 pb-10 pt-6 md:px-8">
      <div className="bd rounded-lg bg-surface p-1">
        <label htmlFor="board-goal" className="sr-only">描述目标</label>
        <textarea
          id="board-goal"
          value={goal}
          rows={2}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="描述你想让团队完成的目标，例如：为订单列表增加 CSV 导出…"
          className="block min-h-[68px] w-full resize-none rounded-lg border-0 bg-transparent px-3.5 pb-1 pt-3 text-base leading-relaxed text-ink outline-none placeholder:text-muted"
        />
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          <div role="radiogroup" aria-label="执行策略" className="flex items-center gap-1">
            {strategies.map((name) => (
              <button
                key={name}
                role="radio"
                aria-checked={name === activeStrategy}
                type="button"
                onClick={() => setStrategy(name)}
                className={cn(
                  "h-6 cursor-pointer rounded-full px-2.5 text-xs font-medium transition-colors focus-ring",
                  name === activeStrategy ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-surface-3 hover:text-ink",
                )}
              >
                {strategyDisplayName(name)}
              </button>
            ))}
          </div>
          <span className="ml-auto hidden items-center gap-1 text-2xs text-muted sm:flex"><Kbd>⌘</Kbd><Kbd>↵</Kbd>继续</span>
          <Button variant="primary" size="sm" disabled={!goal.trim() || !config || busy} onClick={submit} aria-label="配置并启动">
            配置并启动<ArrowUp className="rotate-45" />
          </Button>
        </div>
      </div>

      {empty ? (
        <Onboarding demo={demo} onPick={(value) => setGoal(value)} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="m-0 text-sm font-semibold text-ink">运行</h2>
            <span className="text-xs text-muted">共 {runs.length} 个</span>
            <div className="bd ml-auto flex h-8 w-full max-w-64 items-center gap-2 rounded-md bg-surface px-2.5 focus-within:shadow-[var(--focus-ring)]">
              <Search className="size-3.5 shrink-0 text-muted" />
              <input
                aria-label="搜索运行"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索目标、状态…"
                className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              />
            </div>
            <Button size="md" onClick={onCleanup} disabled={busy} aria-label="清理历史" title="清理历史">
              <Trash2 />清理历史
            </Button>
          </div>
          <div className="flex flex-col gap-6">
            {(["attention", "active", "done"] as const).map((lane) => (
              <Lane key={lane} lane={lane} cards={board[lane]} selectedRunId={selectedRunId} busy={busy} loading={loading} onOpenRun={onOpenRun} onDeleteRun={onDeleteRun} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Lane({ lane, cards, selectedRunId, busy, loading, onOpenRun, onDeleteRun }: { lane: BoardLane; cards: BoardCard[]; selectedRunId: string | undefined; busy: boolean; loading: boolean; onOpenRun(runId: string): void; onDeleteRun(runId: string): void }) {
  const meta = laneMeta[lane];
  return (
    <section aria-label={boardLaneLabels[lane]} className="flex min-w-0 flex-col gap-2.5">
      <header className="flex items-center gap-2 px-1">
        <StatusDot tone={meta.dot} pulse={lane === "active" && cards.length > 0} />
        <h3 className="m-0 text-sm font-semibold text-ink">{boardLaneLabels[lane]}</h3>
        <span className="rounded-full bg-surface-3 px-1.5 text-2xs font-medium leading-4 text-muted">{cards.length}</span>
      </header>
      {cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-xs text-muted">{loading ? "加载中…" : meta.empty}</div>
      ) : (
        <ul className="bd m-0 flex list-none flex-col divide-y divide-line overflow-hidden rounded-lg bg-surface p-0">
          {cards.map((card) => (
            <li key={card.run.id}>
              <RunCard card={card} selected={card.run.id === selectedRunId} busy={busy} onOpen={() => onOpenRun(card.run.id)} onDelete={() => onDeleteRun(card.run.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RunCard({ card, selected, busy, onOpen, onDelete }: { card: BoardCard; selected: boolean; busy: boolean; onOpen(): void; onDelete(): void }) {
  const { run, reason, progress } = card;
  const failure = humanizeFailure(run.error);
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const rail = card.lane === "attention" && reason?.tone === "danger"
    ? "border-l-danger"
    : card.lane === "attention"
      ? "border-l-warning"
      : card.lane === "active"
        ? "border-l-accent"
        : "border-l-success";
  return (
    <article className={cn("group relative border-l-[3px] bg-surface pr-8", rail, selected && "bg-accent-soft/40")}>
      <button type="button" onClick={onOpen} className="block w-full cursor-pointer border-0 bg-transparent px-3 py-2.5 text-left focus-ring" aria-label={`打开运行：${summarizeGoal(run.goal, 80)}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:grid sm:grid-cols-[minmax(0,1fr)_5.5rem_4.5rem_5.25rem_7.5rem]">
          <h4 className="m-0 min-w-0 truncate text-sm font-medium text-ink" title={run.goal}>{summarizeGoal(run.goal, 90)}</h4>
          <span className="justify-self-start">
            {reason ? (
              <Badge tone={reason.tone === "neutral" ? "neutral" : reason.tone}>{reason.label}</Badge>
            ) : (
              <RunStatusPill status={run.status} />
            )}
          </span>
          <span className="truncate text-2xs text-muted">{strategyDisplayName(run.strategy)}</span>
          <span className="flex items-center justify-end gap-1 text-2xs text-muted"><Clock className="size-3 shrink-0" />{formatRelative(run.updatedAt)}</span>
          {progress.total > 0 ? (
            <span className="flex items-center gap-2">
              <span
                role="progressbar"
                aria-label="任务进度"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
                aria-valuetext={`${progress.done}/${progress.total} 个任务`}
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3"
              >
                <span className={cn("block h-full rounded-full", card.lane === "attention" && reason?.tone === "danger" ? "bg-danger" : "bg-accent")} style={{ width: `${percent}%` }} />
              </span>
              <span className="w-7 text-right text-2xs tabular-nums text-muted">{progress.done}/{progress.total}</span>
            </span>
          ) : (
            <span />
          )}
        </div>
        {failure && card.lane !== "active" && <p className="m-0 mt-1 line-clamp-1 text-xs text-danger-ink">{failure}</p>}
      </button>
      {deletableStatuses.has(run.status) && (
        <button
          type="button"
          disabled={busy}
          aria-label="删除运行"
          title="删除运行"
          onClick={onDelete}
          className="absolute right-2 top-2 grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-surface-2 text-muted opacity-0 transition-opacity hover:text-danger-ink focus-visible:opacity-100 group-hover:opacity-100 focus-ring"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </article>
  );
}

function Onboarding({ demo, onPick }: { demo: boolean; onPick(goal: string): void }) {
  const steps = [
    ["描述目标", "用一句话说清楚要交付什么，总控会把它拆成可并行的任务。"],
    ["团队执行", "架构、实现、评审、测试各司其职，每个任务在独立 worktree 里完成。"],
    ["你来把关", "确定性检查先行；到了审批门，只需要看证据并决定批准或驳回。"],
  ] as const;
  return (
    <div className="bd rounded-lg bg-surface p-6 md:p-8">
      <div className="flex items-center gap-2 text-accent-ink"><Sparkles className="size-4" /><span className="text-xs font-semibold uppercase tracking-wider">开始使用</span></div>
      <h2 className="m-0 mt-2 text-xl font-semibold tracking-tight text-ink">这个项目还没有运行</h2>
      <p className="m-0 mt-1.5 max-w-xl text-sm leading-relaxed text-muted">在上面的输入框里写下第一个目标，或者从下面的示例开始。</p>
      <ol className="m-0 mt-6 grid list-none gap-4 p-0 md:grid-cols-3">
        {steps.map(([title, text], index) => (
          <li key={title} className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink">{index + 1}</span>
            <div>
              <strong className="text-sm font-semibold text-ink">{title}</strong>
              <p className="m-0 mt-0.5 text-xs leading-relaxed text-muted">{text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap gap-2">
        {sampleGoals.map((value) => (
          <button key={value} type="button" onClick={() => onPick(value)} className="bd h-8 cursor-pointer rounded-full bg-surface-2 px-3.5 text-xs text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent-ink focus-ring">
            {value}
          </button>
        ))}
      </div>
      {!demo && (
        <p className="m-0 mt-5 text-xs text-muted">想先看看效果？在地址后加 <code className="rounded bg-surface-3 px-1">?demo=1</code> 查看带示例数据的控制台。</p>
      )}
    </div>
  );
}
