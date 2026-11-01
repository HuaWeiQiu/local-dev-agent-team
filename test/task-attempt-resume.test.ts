import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskAttemptRunner } from "../src/workflow/task-attempt.js";
import { RunStateStore } from "../src/state/store.js";
import type { ReviewVerdict, TestVerdict } from "../src/domain/contracts.js";
import type { QualityReport } from "../src/quality/run.js";
import type { RunState, TaskRunState } from "../src/state/types.js";
import type { RunnerEnv } from "../src/workflow/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

const approve = (verdict: "approve" | "request_changes" | "escalate"): ReviewVerdict => ({
  verdict,
  summary: `review says ${verdict}`,
  findings: [],
});
const test = (verdict: "approve" | "request_changes" | "escalate"): TestVerdict => ({
  verdict,
  summary: `test says ${verdict}`,
  missingTests: [],
});
const quality = (passed: boolean): QualityReport => ({ passed, commands: [] });

async function fixture(tasks: { id: string; ownedPaths: string[] }[] = [{ id: "T1", ownedPaths: ["src/"] }]) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-resume-"));
  roots.push(root);
  const worktree = path.join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, "changed.ts"), "export const a = 1;\n");
  return {
    root,
    worktree,
    store: new RunStateStore(path.join(root, "runs")),
    plan: { summary: "a plan", tasks },
  };
}

function runner(env: Partial<RunnerEnv> = {}): TaskAttemptRunner {
  return new TaskAttemptRunner(
    {
      loaded: { config: { roles: {}, strategies: { default: "balanced", definitions: {} } } },
      experience: {
        recordAttempt: vi.fn(async () => undefined),
        recordSuccess: vi.fn(async () => undefined),
        loadRework: vi.fn(async () => undefined),
      },
      cleaner: { warn: vi.fn(async () => undefined) },
      ...env,
    } as unknown as RunnerEnv,
    { canConsultAdvisor: () => false } as never,
  );
}

function state(plan: unknown): RunState {
  return {
    id: "run-1",
    goal: "g",
    status: "implementing",
    root: "/tmp",
    configPath: "agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "i",
    integrationWorktree: "/tmp/wt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileOverrides: {},
    strategy: { name: "balanced", maxReworkAttempts: 2, maxParallel: 1 } as never,
    plan,
    tasks: [],
    history: [],
  } as unknown as RunState;
}

function taskState(worktree: string, patch: Partial<TaskRunState> = {}): TaskRunState {
  return {
    task: { id: "T1", title: "Do it", dependsOn: [], ownedPaths: ["src/"], acceptanceCommands: [] },
    status: "working",
    attempts: 1,
    branch: "agent-team/run-1/T1",
    worktree,
    quality: quality(true),
    ...patch,
  } as unknown as TaskRunState;
}

function git(files: string[] = ["src/changed.ts"], diff = "diff") {
  return {
    stage: vi.fn(async () => undefined),
    changedFiles: vi.fn(async () => files),
    stagedDiff: vi.fn(async () => diff),
    assertOwnedPaths: vi.fn(() => undefined),
    commit: vi.fn(async () => "sha123"),
  } as never;
}

function agent(review: ReviewVerdict, testVerdict: TestVerdict) {
  return {
    runStructured: vi.fn(async (input: { role: string }) => ({
      value: input.role === "reviewer" ? review : testVerdict,
    })),
    runText: vi.fn(async () => ({ profileName: "p1" })),
  } as never;
}

describe("resuming a task that already passed", () => {
  it("starts fresh when there is nothing to reuse", async () => {
    const f = await fixture();
    const run = state(f.plan);
    const task = taskState(f.worktree, { quality: quality(false) });
    await expect(
      runner().tryFinishAlreadyPassedTask(run, task, f.store, git(), agent(approve("approve"), test("approve"))),
    ).resolves.toBe("fresh");
  });

  it("commits at once when the earlier attempt already committed", async () => {
    const f = await fixture();
    const run = state(f.plan);
    const task = taskState(f.worktree, { commit: "abc123" });
    await expect(
      runner().tryFinishAlreadyPassedTask(run, task, f.store, git(), agent(approve("approve"), test("approve"))),
    ).resolves.toBe("committed");
    expect(task.status).toBe("passed");
  });

  it("starts fresh when nothing is staged", async () => {
    const f = await fixture();
    const run = state(f.plan);
    await expect(
      runner().tryFinishAlreadyPassedTask(run, taskState(f.worktree), f.store, git([]), agent(approve("approve"), test("approve"))),
    ).resolves.toBe("fresh");
  });

  it("starts fresh when the changes fall outside the owned paths", async () => {
    const f = await fixture();
    const run = state(f.plan);
    const guarded = git();
    (guarded as unknown as { assertOwnedPaths: () => void }).assertOwnedPaths = () => {
      throw new Error("outside owned paths");
    };
    await expect(
      runner().tryFinishAlreadyPassedTask(run, taskState(f.worktree), f.store, guarded, agent(approve("approve"), test("approve"))),
    ).resolves.toBe("fresh");
  });

  it("commits when the earlier review already cleared the gates", async () => {
    const f = await fixture();
    const run = state(f.plan);
    const task = taskState(f.worktree, { review: approve("approve"), test: test("approve") });
    await expect(
      runner().tryFinishAlreadyPassedTask(run, task, f.store, git(), agent(approve("request_changes"), test("request_changes"))),
    ).resolves.toBe("committed");
  });

  it("commits when the review it runs now clears the gates", async () => {
    const f = await fixture();
    const run = state(f.plan);
    await expect(
      runner().tryFinishAlreadyPassedTask(run, taskState(f.worktree), f.store, git(), agent(approve("approve"), test("approve"))),
    ).resolves.toBe("committed");
  });

  it("starts fresh after a specialist escalation that failed the gates", async () => {
    const f = await fixture();
    const run = state(f.plan);
    const task = taskState(f.worktree, { quality: quality(false) });
    await expect(
      runner().tryFinishAlreadyPassedTask(run, task, f.store, git(), agent(approve("escalate"), test("approve"))),
    ).resolves.toBe("fresh");
  });

  it("asks for rework when the gates asked for changes", async () => {
    const f = await fixture();
    const run = state(f.plan);
    // Its earlier quality passed, so the worktree is reusable; the review is what
    // asks for changes now.
    const task = taskState(f.worktree);
    await expect(
      runner().tryFinishAlreadyPassedTask(run, task, f.store, git(), agent(approve("request_changes"), test("request_changes"))),
    ).resolves.toBe("rework");
    expect(task.status).toBe("reworking");
    expect(task.error).toBeTruthy();
  });
});
