import { describe, expect, it } from "vitest";
import { demoExplanation } from "../web/src/demo/insights.js";
import { buildDemoRuns } from "../web/src/demo/seed.js";
import type { DemoRun } from "../web/src/demo/seed.js";
import type { RunState } from "../web/src/types.js";

const base = Date.parse("2026-10-30T12:00:00.000Z");
const runs = buildDemoRuns(base);

function runWith(state: Partial<RunState>): DemoRun {
  const baseRun = runs[0]!;
  return { ...baseRun, state: { ...baseRun.state, ...state } } as DemoRun;
}

function task(patch: Record<string, unknown> = {}) {
  return {
    task: { id: "T1", title: "任务 T1", description: "", dependsOn: [], ownedPaths: [], acceptanceCommands: [] },
    status: "passed",
    attempts: 1,
    ...patch,
  } as never;
}

describe("demoExplanation", () => {
  it("explains a completed run", () => {
    const explanation = demoExplanation(
      runWith({
        status: "completed",
        tasks: [task(), task({ task: { id: "T2", title: "任务 T2" } })],
        finalQuality: { passed: true, commands: [] } as never,
      }),
    );
    expect(explanation.headline).toEqual({ tone: "good", text: "已完成：2/2 个任务已合并" });
    expect(explanation.run[0]).toMatchObject({ tone: "good" });
  });

  it("leads with the blocked task", () => {
    const explanation = demoExplanation(
      runWith({ status: "implementing", tasks: [task({ status: "blocked", error: "门禁失败" })] }),
    );
    expect(explanation.headline.tone).toBe("bad");
    expect(explanation.headline.text).toContain("T1");
    expect(explanation.headline.text).toContain("门禁失败");
  });

  it("falls back to a neutral headline while running", () => {
    const explanation = demoExplanation(runWith({ status: "implementing", tasks: [task()] }));
    expect(explanation.headline.tone).toBe("neutral");
    expect(explanation.headline.text).toContain("进行中");
  });

  it("reports a failed final gate and no gate at all", () => {
    const failed = demoExplanation(
      runWith({ finalQuality: { passed: false, commands: [] } as never, tasks: [task()] }),
    );
    expect(failed.run[0]).toMatchObject({ tone: "bad" });
    expect(demoExplanation(runWith({ finalQuality: undefined, tasks: [task()] })).run).toEqual([]);
  });

  it("summarizes each task's quality and review lines", () => {
    const explanation = demoExplanation(
      runWith({
        tasks: [
          task({
            status: "blocked",
            attempts: 2,
            quality: { passed: false, commands: [{}, {}] } as never,
            review: { verdict: "request_changes", summary: "需要重做" } as never,
          }),
          task({ attempts: 3, task: { id: "T2", title: "任务 T2" } }),
        ],
      }),
    );
    const first = explanation.tasks[0]!;
    expect(first.tone).toBe("bad");
    expect(first.summary).toBe("任务被阻塞");
    expect(first.lines.map((line) => line.tone)).toEqual(["bad", "warn"]);
    expect(first.lines[1]?.text).toContain("需要重做");

    const second = explanation.tasks[1]!;
    expect(second.tone).toBe("good");
    expect(second.summary).toContain("3 次尝试");
    expect(second.lines).toEqual([]);
  });

  it("describes a single-pass task with a passing gate", () => {
    const explanation = demoExplanation(
      runWith({
        tasks: [task({ quality: { passed: true, commands: [{}, {}, {}] } as never, review: { verdict: "approve", summary: "很好" } as never })],
      }),
    );
    const first = explanation.tasks[0]!;
    expect(first.summary).toBe("一次通过全部门禁");
    expect(first.lines[0]?.text).toBe("质量门禁通过（3 条命令）");
    expect(first.lines[1]?.tone).toBe("good");
  });
});
