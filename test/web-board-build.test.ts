import { describe, expect, it } from "vitest";
import { buildBoard } from "../web/src/board.js";
import type { RunStatus, RunSummary } from "../web/src/types.js";

function run(patch: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "r1",
    goal: "goal",
    status: "implementing" as RunStatus,
    updatedAt: "2026-11-02T00:00:00.000Z",
    taskCounts: { merged: 1, passed: 1, failed: 0, pending: 2 },
    ...patch,
  } as RunSummary;
}

describe("buildBoard", () => {
  it("puts a run with an outstanding question in the attention lane even while it runs", () => {
    const board = buildBoard([run({ agentQuestions: 2 })]);

    expect(board.attention).toHaveLength(1);
    expect(board.attention[0]?.reason).toMatchObject({ label: "智能体在提问", priority: 6 });
    expect(board.active).toEqual([]);
  });

  it("sorts attention by priority and then by recency", () => {
    const board = buildBoard([
      run({ id: "blocked", status: "blocked", updatedAt: "2026-11-02T03:00:00.000Z" }),
      run({ id: "approval", status: "awaiting-human", updatedAt: "2026-11-02T01:00:00.000Z" }),
      run({ id: "question", agentQuestions: 1, updatedAt: "2026-11-02T02:00:00.000Z" }),
      run({ id: "other-approval", status: "awaiting-human", updatedAt: "2026-11-02T04:00:00.000Z" }),
    ]);

    expect(board.attention.map((card) => card.run.id)).toEqual([
      "question",
      "other-approval",
      "approval",
      "blocked",
    ]);
  });

  it("sorts the active and done lanes newest first", () => {
    const board = buildBoard([
      run({ id: "older", updatedAt: "2026-11-02T01:00:00.000Z" }),
      run({ id: "newer", updatedAt: "2026-11-02T05:00:00.000Z" }),
      run({ id: "finished", status: "completed", updatedAt: "2026-11-02T02:00:00.000Z" }),
    ]);

    expect(board.active.map((card) => card.run.id)).toEqual(["newer", "older"]);
    expect(board.done.map((card) => card.run.id)).toEqual(["finished"]);
  });

  it("counts finished tasks and labels the status", () => {
    const board = buildBoard([run({ taskCounts: { merged: 2, passed: 1, failed: 1, pending: 1 } })]);

    expect(board.active[0]?.progress).toEqual({ done: 3, total: 5 });
    expect(board.active[0]?.statusLabel).toBeTruthy();
  });

  it("leaves the reason off a card that needs nothing", () => {
    const board = buildBoard([run({ status: "implementing" })]);

    expect(board.active[0]).not.toHaveProperty("reason");
  });

  it("keeps a run without questions out of attention when its status is unknown", () => {
    const board = buildBoard([run({ status: "mystery" as RunStatus, agentQuestions: 0 })]);

    expect(board.attention).toEqual([]);
    expect(board.done).toHaveLength(1);
  });
});
