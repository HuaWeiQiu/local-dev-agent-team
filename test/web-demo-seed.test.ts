import { describe, expect, it } from "vitest";
import {
  buildDemoRuns,
  buildEvidence,
  buildExperience,
  buildUsage,
  iso,
} from "../web/src/demo/seed.js";
import type { DemoRun } from "../web/src/demo/seed.js";
import type { RunState } from "../web/src/types.js";

const base = Date.parse("2026-10-30T12:00:00.000Z");
const runs = buildDemoRuns(base);

function runWith(state: Partial<RunState>): DemoRun {
  const baseRun = runs[0]!;
  return { ...baseRun, state: { ...baseRun.state, ...state } } as DemoRun;
}

describe("demo seed", () => {
  it("produces a stable set of demo runs", () => {
    expect(runs.length).toBeGreaterThan(1);
    expect(new Set(runs.map((run) => run.state.id)).size).toBe(runs.length);
    expect(runs.every((run) => run.state.tasks.length > 0)).toBe(true);
    expect(iso(0, base)).toBe("2026-10-30T12:00:00.000Z");
  });

  it("builds evidence for a blocked run", () => {
    const blocked = runs.find((run) => run.state.status === "blocked") ?? runWith({ status: "blocked" });
    const evidence = buildEvidence(blocked);
    expect(evidence.readiness).toBe("attention");
    expect(evidence.checks.find((check) => check.id === "tasks")?.status).toBe("fail");
  });

  it("marks a completed run with everything passed as ready", () => {
    const completed = runWith({
      status: "completed",
      approvals: [],
      finalQuality: { passed: true, commands: [] } as never,
      finalDecision: { decision: "ready", reason: "全部通过" } as never,
      tasks: runWith({}).state.tasks.map((task) => ({ ...task, status: "merged" })),
    });
    const evidence = buildEvidence(completed);
    expect(evidence.readiness).toBe("ready");
    expect(evidence.checks.every((check) => check.status === "pass")).toBe(true);
    expect(evidence.diff.available).toBe(true);
  });

  it("reports missing quality, decision and diff", () => {
    const early = runWith({
      status: "implementing",
      finalQuality: undefined,
      finalDecision: undefined,
      approvals: [],
    });
    const noDiff: DemoRun = { ...early, diff: "", changedFiles: [] } as DemoRun;
    const evidence = buildEvidence(noDiff);
    expect(evidence.readiness).toBe("in-progress");
    expect(evidence.checks.find((check) => check.id === "quality")).toMatchObject({
      status: "pending",
      detail: "尚未运行",
    });
    expect(evidence.checks.find((check) => check.id === "decision")?.detail).toBe("等待裁决");
    expect(evidence.diff.available).toBe(false);
    expect(evidence.diff.detail).toBeTruthy();
  });

  it("waits on a pending approval", () => {
    const pending = runWith({
      status: "awaiting-human",
      approvals: [
        {
          id: "a-1",
          gate: "final",
          status: "pending",
          summary: "确认",
          checkpointId: "c",
          requestedAt: iso(0, base),
          expiresAt: iso(minute, base),
        },
      ] as never,
    });
    const evidence = buildEvidence(pending);
    expect(evidence.readiness).toBe("ready");
    expect(evidence.checks.find((check) => check.id === "approval")).toMatchObject({
      status: "pending",
      detail: "等待你确认",
    });
  });

  it("fails the quality check when the final quality did not pass", () => {
    const failed = runWith({
      status: "ci-failed",
      finalQuality: { passed: false, commands: [] } as never,
    });
    expect(buildEvidence(failed).checks.find((check) => check.id === "quality")?.status).toBe("fail");
  });

  it("sums usage across runs and defaults missing counters to zero", () => {
    const report = buildUsage([
      runWith({ usage: { agentInvocations: 3, inputTokens: 100, outputTokens: 50 } as never }),
      runWith({ usage: undefined }),
    ]);
    expect(report.runCount).toBe(2);
    expect(report.totals.agentInvocations).toBe(3);
    expect(report.totals.inputTokens).toBe(100);
    expect(report.totals.outputTokens).toBe(50);
    expect(report.totals.artifactBytes).toBe(0);
    expect(report.totals.costReported).toBe(true);
    expect(report.runs[1]?.usage.agentInvocations).toBe(0);
    expect(report.generatedAt).toMatch(/T/);
  });
});

describe("demo events and experience", () => {
  it("emits a narrative for every task state", () => {
    for (const run of runs) {
      expect(run.events.length).toBeGreaterThan(0);
      expect(run.events[0]?.sequence).toBe(1);
      expect(run.events.every((event) => event.runId === run.state.id)).toBe(true);
    }
    const types = runs.flatMap((run) => run.events.map((event) => event.type));
    expect(types).toEqual(
      expect.arrayContaining([
        "agent.invocation.started",
        "agent.invocation.completed",
        "agent.stdout",
        "run.wave.started",
        "run.wave.completed",
        "approval.requested",
      ]),
    );
  });

  it("adds a terminal status event for a failed run", () => {
    const failed = runs.find((run) => run.state.status === "ci-failed" || run.state.status === "blocked");
    expect(failed?.events.at(-1)?.type).toBe("run.updated");
  });

  it("seeds the experience library", () => {
    const snapshot = buildExperience(base);
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.counts.project).toBeGreaterThanOrEqual(0);
  });
});

const minute = 60_000;
