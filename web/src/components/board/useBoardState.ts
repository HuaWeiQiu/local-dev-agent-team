import { useMemo, useState, type KeyboardEvent } from "react";
import { buildBoard } from "../../board";
import type { PublicConfig, RunSummary } from "../../types";

export interface BoardState {
  query: string;
  goal: string;
  strategies: string[];
  activeStrategy: string | undefined;
  board: ReturnType<typeof buildBoard>;
  setQuery(value: string): void;
  setGoal(value: string): void;
  setStrategy(name: string): void;
  submit(): void;
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
}

/** Board inputs: the goal draft, the strategy pick, and the search query. */
export function useBoardState(input: {
  runs: RunSummary[];
  config: PublicConfig | undefined;
  onCreate(goal: string, strategy: string | undefined): void;
}): BoardState {
  const [query, setQuery] = useState("");
  const [goal, setGoal] = useState("");
  const [strategy, setStrategy] = useState<string>();
  const strategies = input.config ? Object.keys(input.config.strategies.definitions) : [];
  const activeStrategy = strategy ?? input.config?.strategies.default;
  const board = useMemo(
    () => buildBoard(filterRuns(input.runs, query)),
    [input.runs, query],
  );
  const submit = (): void => {
    const trimmed = goal.trim();
    if (!trimmed || !input.config) return;
    input.onCreate(trimmed, activeStrategy);
    setGoal("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    submit();
  };
  return { query, goal, strategies, activeStrategy, board, setQuery, setGoal, setStrategy, submit, onKeyDown };
}

/** Empty query means "everything"; otherwise match goal, id, status or strategy. */
export function filterRuns(runs: RunSummary[], query: string): RunSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return runs;
  return runs.filter((run) =>
    [run.goal, run.id, run.status, run.strategy].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    ),
  );
}
