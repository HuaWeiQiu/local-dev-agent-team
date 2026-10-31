import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleAgentService } from "../src/agents/service.js";
import { runQualityWithRerun } from "../src/quality/flaky.js";
import { StallWatchdog } from "../src/reliability/stall.js";
import { TaskBudgetAgent, TaskBudgetExceededError } from "../src/reliability/task-budget.js";

describe("StallWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the silence window and not again until touched", () => {
    const onStall = vi.fn();
    const watchdog = new StallWatchdog({ stallMs: 1_000, onStall });
    watchdog.start();
    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    watchdog.touch();
    vi.advanceTimersByTime(1_000);
    expect(onStall).toHaveBeenCalledTimes(2);
    watchdog.stop();
  });

  it("treats activity as progress", () => {
    const onStall = vi.fn();
    const watchdog = new StallWatchdog({ stallMs: 1_000, onStall });
    watchdog.start();
    for (let index = 0; index < 5; index += 1) {
      vi.advanceTimersByTime(600);
      watchdog.touch();
    }
    expect(onStall).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("waits while paused and fires after the pause ends", () => {
    let paused = true;
    const onStall = vi.fn();
    const watchdog = new StallWatchdog({ stallMs: 1_000, onStall, isPaused: () => paused });
    watchdog.start();
    vi.advanceTimersByTime(5_000);
    expect(onStall).not.toHaveBeenCalled();
    paused = false;
    vi.advanceTimersByTime(1_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });
});

describe("runQualityWithRerun", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "flaky-test-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const flakyCommand = (marker: string, passOnRun: number) => ({
    command: process.execPath,
    args: [
      "-e",
      `const fs=require("fs");const f=${JSON.stringify(marker)};` +
        `const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;fs.writeFileSync(f,String(n));` +
        `process.exit(n>=${passOnRun}?0:1)`,
    ],
  });

  it("passes and records the command as flaky when a rerun succeeds", async () => {
    const marker = path.join(directory, "count");
    const report = await runQualityWithRerun(
      directory,
      [flakyCommand(marker, 2)],
      30,
      path.join(directory, "artifacts"),
      undefined,
      {},
      1,
    );
    expect(report.passed).toBe(true);
    expect(report.flaky).toHaveLength(1);
    expect(report.reruns).toBe(1);
    expect(await readFile(marker, "utf8")).toBe("2");
  });

  it("keeps a persistent failure failing after the reruns", async () => {
    const marker = path.join(directory, "count");
    const report = await runQualityWithRerun(directory, [flakyCommand(marker, 99)], 30, undefined, undefined, {}, 2);
    expect(report.passed).toBe(false);
    expect(report.flaky).toBeUndefined();
    expect(report.reruns).toBe(2);
    expect(await readFile(marker, "utf8")).toBe("3");
  });

  it("does not rerun when disabled or when everything passes", async () => {
    const marker = path.join(directory, "count");
    const failing = await runQualityWithRerun(directory, [flakyCommand(marker, 2)], 30, undefined, undefined, {}, 0);
    expect(failing.passed).toBe(false);
    expect(failing.reruns).toBeUndefined();
    const passing = await runQualityWithRerun(directory, [flakyCommand(marker, 1)], 30, undefined, undefined, {}, 3);
    expect(passing.passed).toBe(true);
    expect(passing.reruns).toBeUndefined();
  });

  it("only reruns from the failing command and keeps earlier passes", async () => {
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    await writeFile(first, "0");
    const report = await runQualityWithRerun(
      directory,
      [flakyCommand(first, 1), flakyCommand(second, 2)],
      30,
      undefined,
      undefined,
      {},
      1,
    );
    expect(report.passed).toBe(true);
    expect(report.commands).toHaveLength(2);
    expect(await readFile(first, "utf8")).toBe("1");
    expect(await readFile(second, "utf8")).toBe("2");
  });

  it("does not rerun a timed-out command", async () => {
    const marker = path.join(directory, "count");
    const slow = {
      command: process.execPath,
      args: [
        "-e",
        `require("fs").appendFileSync(${JSON.stringify(marker)},"x");setTimeout(()=>{},60000)`,
      ],
    };
    const report = await runQualityWithRerun(directory, [slow], 0.3, undefined, undefined, {}, 2);
    expect(report.passed).toBe(false);
    expect(report.commands[0]?.timedOut).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("x");
  });
});

describe("TaskBudgetAgent", () => {
  const inner: RoleAgentService = {
    runStructured: vi.fn(async () => ({ value: {} }) as never),
    runText: vi.fn(async () => ({ text: "ok" }) as never),
  };

  it("blocks after the invocation limit and reports each count", async () => {
    const counts: number[] = [];
    const agent = new TaskBudgetAgent(inner, "T1", { maxAgentInvocations: 2 }, 0, (count) => counts.push(count));
    await agent.runText({ role: "worker", context: {}, runId: "r", artifactKey: "a" });
    await agent.runText({ role: "worker", context: {}, runId: "r", artifactKey: "b" });
    await expect(
      agent.runText({ role: "worker", context: {}, runId: "r", artifactKey: "c" }),
    ).rejects.toBeInstanceOf(TaskBudgetExceededError);
    expect(counts).toEqual([1, 2]);
  });

  it("counts invocations already spent before a resume", async () => {
    const agent = new TaskBudgetAgent(inner, "T1", { maxAgentInvocations: 3 }, 3);
    await expect(
      agent.runText({ role: "worker", context: {}, runId: "r", artifactKey: "a" }),
    ).rejects.toThrow(/budget of 3/);
  });

  it("enforces the time budget", async () => {
    let now = 0;
    const agent = new TaskBudgetAgent(inner, "T1", { maxMinutes: 1 }, 0, undefined, () => now);
    await agent.runText({ role: "worker", context: {}, runId: "r", artifactKey: "a" });
    now = 61_000;
    await expect(
      agent.runText({ role: "worker", context: {}, runId: "r", artifactKey: "b" }),
    ).rejects.toThrow(/time budget/);
  });
});
