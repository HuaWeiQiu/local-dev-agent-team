import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import type { RunEvent } from "../src/events/types.js";
import { runProcess } from "../src/process/run.js";
import { listenControlServer } from "../src/server/http.js";
import { RunSupervisor } from "../src/server/supervisor.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState, TaskRunState } from "../src/state/types.js";
import { explainRun } from "../src/visibility/explain.js";
import { buildReplay } from "../src/visibility/replay.js";
import { listTranscripts, parseSessionLog } from "../src/visibility/transcript.js";
import { foldRunUsage } from "../src/visibility/usage.js";

let sequence = 0;
function event(type: string, payload: unknown, occurredAt = new Date(1_700_000_000_000 + sequence * 1_000).toISOString()): RunEvent {
  sequence += 1;
  return {
    id: `e${sequence}`,
    schemaVersion: 1,
    runId: "r1",
    type,
    occurredAt,
    payload,
    sequence,
    traceId: "t",
    spanId: "s",
  };
}

function task(id: string, patch: Partial<TaskRunState> = {}): TaskRunState {
  return {
    task: {
      id,
      title: `Task ${id}`,
      description: "d",
      dependsOn: [],
      ownedPaths: ["**"],
      acceptanceCommands: [],
      profile: null,
    } as TaskRunState["task"],
    status: "pending",
    attempts: 0,
    ...patch,
  };
}

function baseState(patch: Partial<RunState> = {}): RunState {
  const now = new Date().toISOString();
  return {
    id: "r1",
    goal: "goal",
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "agent-team/r1/integration",
    integrationWorktree: "/tmp/r1",
    status: "awaiting-human",
    createdAt: now,
    updatedAt: now,
    profileOverrides: {},
    strategy: {
      name: "balanced",
      maxParallel: 2,
      maxReworkAttempts: 2,
      executionTimeoutSeconds: 14_400,
      maxAgentInvocations: 64,
      maxProcessOutputBytes: 1_048_576,
      maxArtifactBytes: 1_073_741_824,
      roleProfiles: {},
      approvalGates: ["final"],
      approvalTimeoutSeconds: 86_400,
    },
    tasks: [],
    history: [],
    ...patch,
  } as RunState;
}

describe("foldRunUsage", () => {
  it("rolls invocations up by role, task and profile and keeps unknown cost distinct from zero", () => {
    const usage = foldRunUsage([
      event("agent.invocation.completed", {
        role: "worker",
        profile: "codex",
        model: "m1",
        artifactKey: "tasks/T1/attempt-1/worker",
        durationMs: 2_000,
        success: true,
        usage: { inputTokens: 100, outputTokens: 50, reportedCostUsd: 0.5 },
      }),
      event("agent.invocation.completed", {
        role: "worker",
        profile: "codex",
        model: "m1",
        artifactKey: "recoveries/1/tasks/T1/attempt-2/worker",
        durationMs: 1_000,
        success: false,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      event("agent.invocation.completed", {
        role: "architect",
        profile: "claude",
        model: "m2",
        artifactKey: "architect",
        durationMs: 500,
        success: true,
      }),
      event("run.updated", {}),
    ]);

    expect(usage.total).toMatchObject({ invocations: 3, failures: 1, inputTokens: 110, outputTokens: 55, durationMs: 3_500 });
    expect(usage.total.costUsd).toBeCloseTo(0.5);
    expect(usage.byRole.map((line) => [line.role, line.invocations])).toEqual([
      ["worker", 2],
      ["architect", 1],
    ]);
    expect(usage.byTask).toHaveLength(1);
    expect(usage.byTask[0]).toMatchObject({ taskId: "T1", invocations: 2, failures: 1 });
    expect(usage.unattributed.invocations).toBe(1);
    expect(usage.unattributed.costReported).toBe(false);
    expect(usage.byProfile.map((line) => line.profile)).toEqual(["codex", "claude"]);
  });
});

describe("explainRun", () => {
  it("explains a delivered run from recorded facts", () => {
    const state = baseState({
      tasks: [
        task("T1", {
          status: "merged",
          attempts: 2,
          quality: {
            passed: true,
            commands: [{ spec: { command: "pnpm", args: ["test"] }, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }],
            flaky: [{ command: "pnpm", args: ["test"] }],
          },
          review: { verdict: "approve", summary: "Looks right", findings: [] },
        }),
      ],
      finalQuality: { passed: true, commands: [] },
      finalDecision: { decision: "ready", reason: "All gates passed" },
    });
    const explanation = explainRun(state, [
      event("flow.triage", { taskId: "T1", attempt: 2, decision: "retry", source: "signature", reason: "New failure: flaky" }),
    ]);

    expect(explanation.headline).toMatchObject({ tone: "good" });
    expect(explanation.tasks[0]?.summary).toContain("2 次尝试");
    const text = explanation.tasks[0]!.lines.map((line) => line.text).join("\n");
    expect(text).toContain("重跑后通过");
    expect(text).toContain("评审 approve");
    expect(text).toContain("重试");
    expect(explanation.run.map((line) => line.text).join("\n")).toContain("All gates passed");
  });

  it("names the failing command and lets it veto a ready model decision", () => {
    const failed = {
      passed: false,
      commands: [{ spec: { command: "pnpm", args: ["lint"] }, exitCode: 2, stdout: "", stderr: "", durationMs: 1, timedOut: false }],
    };
    const state = baseState({
      tasks: [task("T1", { status: "merged", attempts: 1 })],
      finalQuality: failed,
      finalDecision: { decision: "ready", reason: "Looks fine" },
    });
    const explanation = explainRun(state, []);
    expect(explanation.headline.tone).toBe("bad");
    expect(explanation.headline.text).toContain("否决");
    expect(explanation.run.map((line) => line.text).join("\n")).toContain("pnpm lint");
  });

  it("surfaces a blocked task's reason in the headline", () => {
    const state = baseState({
      status: "blocked",
      tasks: [task("T1", { status: "blocked", attempts: 2, error: "Stopped after a repeated identical failure: tests" })],
    });
    expect(explainRun(state, []).headline).toEqual({
      tone: "bad",
      text: "已阻塞：任务 T1 Stopped after a repeated identical failure: tests",
    });
  });
});

describe("transcripts", () => {
  it("turns a session log into a readable conversation and pairs tool calls", () => {
    const raw = [
      { at: "2026-01-01T00:00:00Z", type: "turn-started", turnId: "t1" },
      { at: "2026-01-01T00:00:01Z", type: "tool", turnId: "t1", toolId: "c1", name: "shell", status: "started", summary: "ls" },
      { at: "2026-01-01T00:00:02Z", type: "tool", turnId: "t1", toolId: "c1", name: "shell", status: "completed", summary: "ls (exit 0)" },
      { at: "2026-01-01T00:00:03Z", type: "message", turnId: "t1", text: "partial", final: false },
      { at: "2026-01-01T00:00:04Z", type: "message", turnId: "t1", text: "Done.", final: true },
      { at: "2026-01-01T00:00:05Z", type: "turn-completed", turnId: "t1", status: "completed" },
      "not json",
    ]
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n");

    const entries = parseSessionLog(raw);
    expect(entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ["turn", "turn started"],
      ["tool", "ls (exit 0)"],
      ["message", "Done."],
      ["turn", "turn completed"],
    ]);
    expect(entries[1]).toMatchObject({ label: "shell", status: "completed" });
  });

  it("lists agent output directories with the invocation they belong to", () => {
    const list = listTranscripts(
      [
        { path: "tasks/T1/attempt-1/worker/codex/stdout.log", size: 10, kind: "agent-output", previewable: true },
        { path: "tasks/T1/attempt-1/worker/codex/session.jsonl", size: 20, kind: "other", previewable: false },
        { path: "tasks/T1/attempt-1/worker/codex/context.json", size: 5, kind: "context", previewable: true },
        { path: "tasks/T1/attempt-1/quality/1.log", size: 5, kind: "quality", previewable: true },
      ],
      [
        event("agent.invocation.completed", {
          artifactKey: "tasks/T1/attempt-1/worker",
          profile: "codex",
          role: "worker",
          success: true,
          durationMs: 1_200,
        }),
      ],
    );
    expect(list).toEqual([
      {
        id: "tasks/T1/attempt-1/worker/codex",
        artifactKey: "tasks/T1/attempt-1/worker",
        profile: "codex",
        role: "worker",
        taskId: "T1",
        live: true,
        success: true,
        durationMs: 1_200,
        bytes: 30,
      },
    ]);
  });
});

describe("buildReplay", () => {
  it("merges status history and ledger decisions in time order", () => {
    const state = baseState({
      history: [
        { at: "2026-01-01T00:00:00.000Z", status: "orchestrating", message: "Started" },
        { at: "2026-01-01T00:00:10.000Z", status: "blocked", message: "Task T1 blocked" },
      ],
    });
    const steps = buildReplay(state, [
      event("flow.triage", { taskId: "T1", attempt: 2, decision: "stop", source: "limit", reason: "same failure" }, "2026-01-01T00:00:05.000Z"),
      event("agent.stalled", { role: "worker", taskId: "T1", idleSeconds: 600 }, "2026-01-01T00:00:03.000Z"),
      event("agent.stdout", { chunk: "noise" }, "2026-01-01T00:00:04.000Z"),
    ]);
    expect(steps.map((step) => [step.offsetMs, step.kind])).toEqual([
      [0, "status"],
      [3_000, "operator"],
      [5_000, "triage"],
      [10_000, "status"],
    ]);
    expect(steps[2]).toMatchObject({ tone: "bad", taskId: "T1", detail: "same failure" });
    expect(steps[3]).toMatchObject({ tone: "bad" });
  });
});

describe("insight routes", () => {
  it("serves explain, usage, replay, transcripts and task diffs for a run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-insights-"));
    for (const args of [["init", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@example.com"]]) {
      await runProcess({ command: "git", args, cwd: root, timeoutMs: 30_000 });
    }
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(createDefaultConfig("insights")));
    await writeFile(path.join(root, "a.txt"), "one\n");
    await runProcess({ command: "git", args: ["add", "."], cwd: root, timeoutMs: 30_000 });
    await runProcess({ command: "git", args: ["commit", "-m", "base"], cwd: root, timeoutMs: 30_000 });
    await writeFile(path.join(root, "a.txt"), "one\ntwo\n");
    await runProcess({ command: "git", args: ["commit", "-am", "task change"], cwd: root, timeoutMs: 30_000 });
    const commit = (await runProcess({ command: "git", args: ["rev-parse", "HEAD"], cwd: root, timeoutMs: 30_000 })).stdout.trim();

    const loaded = await loadConfig(root);
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = baseState({ id: "insight-run", tasks: [task("T1", { status: "merged", attempts: 1, commit })] });
    await states.save(state);
    events.emit(state.id, "agent.invocation.completed", {
      role: "worker",
      profile: "codex",
      model: "m",
      artifactKey: "tasks/T1/attempt-1/worker",
      durationMs: 1_000,
      success: true,
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    const dir = states.artifactDirectory(state.id, "tasks", "T1", "attempt-1", "worker", "codex");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stdout.log"), "plain output");
    await writeFile(
      path.join(dir, "session.jsonl"),
      `${JSON.stringify({ at: "2026-01-01T00:00:00Z", type: "message", turnId: "t", text: "hello there", final: true })}\n`,
    );
    await symlink("/etc/hosts", path.join(states.artifactDirectory(state.id, "tasks", "T1"), "link"));

    const supervisor = new RunSupervisor(loaded, events);
    const staticDirectory = path.join(root, "web");
    await mkdir(staticDirectory, { recursive: true });
    await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
    const listening = await listenControlServer(loaded, supervisor, { host: "127.0.0.1", port: 0, staticDirectory });
    const get = async (route: string) => {
      const response = await fetch(`${listening.url}/api/runs/${state.id}/${route}`);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };

    expect((await get("explain")).body.explanation.headline.tone).toBeDefined();
    expect((await get("usage")).body.usage.total).toMatchObject({ invocations: 1, inputTokens: 5 });
    expect((await get("replay")).body.steps).toEqual(expect.any(Array));

    const list = await get("transcripts");
    expect(list.body.transcripts).toEqual([
      expect.objectContaining({ id: "tasks/T1/attempt-1/worker/codex", role: "worker", taskId: "T1", live: true }),
    ]);
    const transcript = await get(`transcript?id=${encodeURIComponent("tasks/T1/attempt-1/worker/codex")}`);
    expect(transcript.body.transcript.entries).toEqual([
      expect.objectContaining({ kind: "message", text: "hello there" }),
    ]);
    expect((await get(`transcript?id=${encodeURIComponent("../../etc")}`)).status).toBe(400);
    expect((await get("transcript")).status).toBe(400);
    expect((await get(`transcript?id=${encodeURIComponent("tasks/T1/link/x")}`)).status).toBe(400);

    const diff = await get("tasks/T1/diff");
    expect(diff.body.diff).toMatchObject({ available: true, source: "commit", changedFiles: ["a.txt"] });
    expect(diff.body.diff.content).toContain("+two");
    expect((await get("tasks/T9/diff")).status).toBe(404);
    const missing = await fetch(`${listening.url}/api/runs/nope/explain`);
    expect(missing.status).toBe(404);

    await listening.close();
    await supervisor.close();
    events.close();
  }, 60_000);
});
