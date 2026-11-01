import { CheckCircle2, type Clock, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import { boardLaneLabels, type BoardCard, type BoardLane } from "../board";
import { AttentionPanel } from "./AttentionPanel";
import { RunCard } from "./board/RunCard";
import { BOARD_LANES, BoardToolbar, GoalComposer } from "./board/sections";
import { useBoardState } from "./board/useBoardState";
import type { ProjectScope, PublicConfig, RunStatus, RunSummary } from "../types";
import { StatusDot } from "../ui/status";

const deletableStatuses = new Set<RunStatus>(["completed", "cancelled", "blocked", "interrupted"]);

const sampleGoals = [
  "为订单列表增加 CSV 导出，支持按时间范围筛选",
  "把重复的表单校验逻辑抽成共享模块并补测试",
  "修复结算页在小屏幕下按钮被遮挡的问题",
];

interface BoardPageProps {
  runs: RunSummary[];
  config: PublicConfig | undefined;
  scope: ProjectScope | undefined;
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

export function BoardPage({ runs, config, scope, selectedRunId, busy, loading, demo, onOpenRun, onCreate, onCleanup, onDeleteRun }: BoardPageProps) {
  const state = useBoardState({ runs, config, onCreate });
  const empty = !loading && runs.length === 0;

  return (
    <section aria-label="运行工作台" className="scroll-thin mx-auto flex h-full w-full max-w-[1280px] flex-col gap-6 overflow-y-auto px-4 pb-10 pt-6 md:px-8">
      <GoalComposer
        goal={state.goal}
        strategies={state.strategies}
        activeStrategy={state.activeStrategy}
        config={config}
        busy={busy}
        onGoal={state.setGoal}
        onStrategy={state.setStrategy}
        onSubmit={state.submit}
        onKeyDown={state.onKeyDown}
      />

      {empty ? (
        <Onboarding demo={demo} onPick={(value) => state.setGoal(value)} />
      ) : (
        <>
          {scope && <AttentionPanel scope={scope} />}
          <BoardToolbar total={runs.length} query={state.query} busy={busy} onQuery={state.setQuery} onCleanup={onCleanup} />
          <div className="flex flex-col gap-6">
            {BOARD_LANES.map((lane) => (
              <Lane key={lane} lane={lane} cards={state.board[lane]} selectedRunId={selectedRunId} busy={busy} loading={loading} onOpenRun={onOpenRun} onDeleteRun={onDeleteRun} />
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
              <RunCard card={card} selected={card.run.id === selectedRunId} busy={busy} deletable={deletableStatuses.has(card.run.status)} onOpen={() => onOpenRun(card.run.id)} onDelete={() => onDeleteRun(card.run.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
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
