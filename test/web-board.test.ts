import { describe, expect, it } from "vitest";
import { attentionReason, buildBoard, laneOf, taskProgress } from "../web/src/board.js";
import { deriveStages } from "../web/src/stages.js";
import type { RunStatus, RunSummary } from "../web/src/types.js";

function summary(id: string, status: RunStatus, updatedAt: string, taskCounts: Partial<RunSummary["taskCounts"]> = {}): RunSummary {
  return {
    id,
    goal: id,
    status,
    strategy: "balanced",
    createdAt: updatedAt,
    updatedAt,
    taskCounts: { pending: 0, working: 0, reworking: 0, passed: 0, merged: 0, blocked: 0, ...taskCounts },
  };
}

describe("board lanes", () => {
  it("routes statuses into the three lanes", () => {
    expect(laneOf("awaiting-human")).toBe("attention");
    expect(laneOf("ci-failed")).toBe("attention");
    expect(laneOf("implementing")).toBe("active");
    expect(laneOf("completed")).toBe("done");
    expect(laneOf("cancelled")).toBe("done");
    expect(attentionReason("awaiting-human")?.label).toBe("等你审批");
    expect(attentionReason("completed")).toBeUndefined();
  });

  it("puts the most urgent attention items first, then newest", () => {
    const board = buildBoard([
      summary("interrupted", "interrupted", "2026-08-11T10:00:00Z"),
      summary("approval", "awaiting-human", "2026-08-11T08:00:00Z"),
      summary("blocked-new", "blocked", "2026-08-11T09:30:00Z"),
      summary("blocked-old", "blocked", "2026-08-11T09:00:00Z"),
      summary("running-a", "implementing", "2026-08-11T09:00:00Z"),
      summary("running-b", "implementing", "2026-08-11T09:10:00Z"),
    ]);
    expect(board.attention.map((card) => card.run.id)).toEqual(["approval", "blocked-new", "blocked-old", "interrupted"]);
    expect(board.active.map((card) => card.run.id)).toEqual(["running-b", "running-a"]);
    expect(board.done).toEqual([]);
  });

  it("counts passed and merged tasks as done", () => {
    expect(taskProgress({ pending: 1, working: 1, reworking: 0, passed: 2, merged: 3, blocked: 0 })).toEqual({ done: 5, total: 7 });
  });
});

describe("deriveStages", () => {
  const states = (run: Parameters<typeof deriveStages>[0]) => deriveStages(run).map((stage) => `${stage.id}:${stage.state}`);

  it("marks earlier stages done and the active one current", () => {
    const stages = states({
      status: "implementing",
      history: [{ status: "created" }, { status: "orchestrating" }, { status: "architecting" }, { status: "implementing" }],
    });
    expect(stages.slice(0, 5)).toEqual(["intake:done", "explore:skipped", "plan:done", "build:current", "review:pending"]);
  });

  it("shows the stage where a stopped run ended as failed", () => {
    const stages = states({
      status: "blocked",
      history: [{ status: "created" }, { status: "architecting" }, { status: "implementing" }, { status: "reviewing-testing" }, { status: "blocked" }],
    });
    expect(stages).toContain("plan:done");
    expect(stages).toContain("review:failed");
    expect(stages).toContain("integrate:pending");
  });

  it("fills a completed run, skipping stages it never visited", () => {
    const stages = states({
      status: "completed",
      history: [{ status: "created" }, { status: "architecting" }, { status: "implementing" }, { status: "reviewing-testing" }, { status: "integrating" }, { status: "final-checks" }, { status: "completed" }],
    });
    expect(stages).toEqual([
      "intake:done", "explore:skipped", "plan:done", "build:done", "review:done",
      "integrate:done", "gates:done", "approval:skipped", "ship:skipped",
    ]);
  });
});
