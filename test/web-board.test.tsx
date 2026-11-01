// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { BoardPage } from "../web/src/components/BoardPage.js";
import { RunCard } from "../web/src/components/board/RunCard.js";
import {
  barTone,
  badgeFor,
  goalLabel,
  progressPercent,
  railClass,
  railTone,
  strategyLabel,
  visibleFailure,
} from "../web/src/components/board/card-model.js";
import { filterRuns, useBoardState } from "../web/src/components/board/useBoardState.js";
import type { BoardCard } from "../web/src/board.js";
import type { PublicConfig, RunSummary } from "../web/src/types.js";

function card(patch: Record<string, unknown> = {}): BoardCard {
  const run = {
    id: "run-1",
    goal: "给购物车加优惠券",
    status: "implementing",
    strategy: "balanced",
    updatedAt: "2026-10-30T00:00:00.000Z",
    tasks: [],
    ...(patch.run as object),
  };
  return {
    run,
    lane: "active",
    progress: { done: 1, total: 4 },
    ...patch,
  } as unknown as BoardCard;
}

function summary(patch: Record<string, unknown> = {}): RunSummary {
  return {
    id: "run-1",
    goal: "给购物车加优惠券",
    status: "implementing",
    strategy: "balanced",
    updatedAt: "2026-10-30T00:00:00.000Z",
    createdAt: "2026-10-30T00:00:00.000Z",
    taskCounts: { total: 4, done: 1 },
    ...patch,
  } as unknown as RunSummary;
}

function config(): PublicConfig {
  return {
    strategies: { default: "balanced", definitions: { balanced: {}, fast: {} } },
  } as unknown as PublicConfig;
}

describe("board card model", () => {
  it("picks the rail from the lane, worse when blocked", () => {
    expect(railTone(card({ lane: "attention", reason: { tone: "danger", label: "x" } }), "attention")).toBe("danger");
    expect(railTone(card({ lane: "attention" }), "attention")).toBe("warning");
    expect(railTone(card(), "active")).toBe("accent");
    expect(railTone(card({ lane: "done" }), "done")).toBe("success");
    expect(railClass(card({ lane: "attention", reason: { tone: "danger", label: "x" } }))).toContain("danger");
    expect(barTone(card({ lane: "attention", reason: { tone: "danger", label: "x" } }))).toBe("danger");
    expect(barTone(card())).toBe("accent");
  });

  it("computes progress, labels and failures", () => {
    expect(progressPercent(card())).toBe(25);
    expect(progressPercent(card({ progress: { done: 0, total: 0 } }))).toBe(0);
    expect(goalLabel("x".repeat(120), 10)).toBe("xxxxxxxxx…");
    expect(goalLabel("short", 80)).toBe("short");
    expect(strategyLabel(card())).toBeTruthy();
    expect(visibleFailure(card({ run: { error: "boom" } }))).toBeUndefined();
    expect(visibleFailure(card({ lane: "done", run: { error: "boom" } }))).toBeTruthy();
    expect(badgeFor(card())).toBeUndefined();
    expect(badgeFor(card({ reason: { tone: "danger", label: "阻塞" } }))).toEqual({
      label: "阻塞",
      tone: "danger",
    });
  });
});

describe("useBoardState", () => {
  it("filters runs and submits a trimmed goal", () => {
    const onCreate = vi.fn();
    const runs = [summary(), summary({ id: "run-2", goal: "导出 CSV", status: "completed" })];
    const { result } = renderHook(() => useBoardState({ runs, config: config(), onCreate }));

    expect(result.current.strategies).toEqual(["balanced", "fast"]);
    expect(result.current.activeStrategy).toBe("balanced");

    act(() => result.current.setQuery("csv"));
    expect(filterRuns(runs, "csv")).toHaveLength(1);
    expect(filterRuns(runs, "   ")).toHaveLength(2);
    expect(filterRuns(runs, "RUN-2")).toHaveLength(1);

    act(() => result.current.setGoal("  新目标  "));
    act(() => result.current.submit());
    expect(onCreate).toHaveBeenCalledWith("新目标", "balanced");
    expect(result.current.goal).toBe("");
  });

  it("ignores an empty goal and a missing config", () => {
    const onCreate = vi.fn();
    const empty = renderHook(() => useBoardState({ runs: [], config: config(), onCreate }));
    act(() => empty.result.current.submit());
    expect(onCreate).not.toHaveBeenCalled();

    const noConfig = renderHook(() => useBoardState({ runs: [], config: undefined, onCreate }));
    act(() => noConfig.result.current.setGoal("目标"));
    act(() => noConfig.result.current.submit());
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("submits on Cmd/Ctrl+Enter only", () => {
    const onCreate = vi.fn();
    const { result } = renderHook(() => useBoardState({ runs: [], config: config(), onCreate }));
    act(() => result.current.setGoal("目标"));

    const plain = { key: "Enter", metaKey: false, ctrlKey: false, preventDefault: vi.fn() };
    act(() => result.current.onKeyDown(plain as never));
    expect(onCreate).not.toHaveBeenCalled();

    const chord = { key: "Enter", metaKey: true, ctrlKey: false, preventDefault: vi.fn() };
    act(() => result.current.onKeyDown(chord as never));
    expect(onCreate).toHaveBeenCalled();
  });
});

describe("RunCard", () => {
  it("renders goal, status, strategy and progress", () => {
    render(<RunCard card={card()} selected={false} busy={false} deletable onOpen={() => undefined} onDelete={() => undefined} />);
    expect(screen.getByRole("button", { name: /打开运行/ })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "任务进度" })).toBeTruthy();
    expect(screen.getByText("1/4")).toBeVisible();
  });

  it("prefers the lane reason over the status pill", () => {
    render(
      <RunCard
        card={card({ lane: "attention", reason: { tone: "danger", label: "阻塞" } })}
        selected
        busy={false}
        deletable={false}
        onOpen={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(screen.getByText("阻塞")).toBeVisible();
    expect(screen.queryByRole("button", { name: "删除运行" })).toBeNull();
  });

  it("shows no progress bar when there are no tasks", () => {
    render(
      <RunCard
        card={card({ progress: { done: 0, total: 0 } })}
        selected={false}
        busy={false}
        deletable
        onOpen={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("opens and deletes through its buttons", async () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    render(<RunCard card={card()} selected={false} busy={false} deletable onOpen={onOpen} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole("button", { name: /打开运行/ }));
    await userEvent.click(screen.getByRole("button", { name: "删除运行" }));
    expect(onOpen).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });
});

describe("BoardPage", () => {
  it("shows onboarding when there are no runs", () => {
    render(
      <BoardPage
        runs={[]}
        config={config()}
        scope={undefined}
        selectedRunId={undefined}
        busy={false}
        loading={false}
        demo={false}
        onOpenRun={() => undefined}
        onCreate={() => undefined}
        onCleanup={() => undefined}
        onDeleteRun={() => undefined}
      />,
    );
    expect(screen.getByRole("region", { name: "运行工作台" })).toBeTruthy();
  });

  it("lists lanes and searches", async () => {
    const runs = [summary(), summary({ id: "run-2", goal: "导出 CSV", status: "completed" })];
    render(
      <BoardPage
        runs={runs}
        config={config()}
        scope={undefined}
        selectedRunId={undefined}
        busy={false}
        loading={false}
        demo
        onOpenRun={() => undefined}
        onCreate={() => undefined}
        onCleanup={() => undefined}
        onDeleteRun={() => undefined}
      />,
    );
    expect(screen.getByText("共 2 个")).toBeVisible();
    await userEvent.type(screen.getByLabelText("搜索运行"), "csv");
    expect(screen.getByText("共 2 个")).toBeVisible();
  });

  it("creates a run from the composer", async () => {
    const onCreate = vi.fn();
    render(
      <BoardPage
        runs={[summary()]}
        config={config()}
        scope={undefined}
        selectedRunId={undefined}
        busy={false}
        loading={false}
        demo
        onOpenRun={() => undefined}
        onCreate={onCreate}
        onCleanup={() => undefined}
        onDeleteRun={() => undefined}
      />,
    );
    await userEvent.type(screen.getByLabelText("描述目标"), "新增导出");
    await userEvent.click(screen.getByRole("button", { name: "配置并启动" }));
    expect(onCreate).toHaveBeenCalledWith("新增导出", "balanced");
  });
});
