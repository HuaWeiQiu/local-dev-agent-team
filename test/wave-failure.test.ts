import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import type {
  RoleAgentService,
  RoleInvocationOptions,
  RoleResponse,
  TextRoleInvocationOptions,
  TextRoleResponse,
} from "../src/agents/service.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import type { PendingRunEvent, RunEventSink } from "../src/events/types.js";
import { runProcess } from "../src/process/run.js";
import { LocalWorkflowRunner } from "../src/workflow/runner.js";
import {
  sampleWaveEnvironment,
  waveCompletionPayload,
  waveRejectionFacts,
  waveTaskProgress,
} from "../src/workflow/wave-failure.js";

class ShapeOnlyAgentService implements RoleAgentService {
  async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
    const value =
      options.role === "architect"
        ? {
            summary: "Two independent files",
            tasks: ["alpha", "beta"].map((id) => ({
              id,
              title: id,
              description: `Create ${id}.txt`,
              dependsOn: [],
              ownedPaths: [`${id}.txt`],
              acceptanceCommands: [],
              profile: null,
            })),
          }
        : options.role === "orchestrator" && options.promptKey !== "orchestrator-final"
          ? { goalSummary: "Create two files", instructionsForArchitect: "Split", constraints: [], risk: "low" }
          : { decision: "ready", reason: "All gates passed" };
    return {
      value: options.schema.parse(value),
      profileName: "fake",
      usedFallback: false,
      text: JSON.stringify(value),
    };
  }

  async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
    const context = options.context as { task: { id: string; ownedPaths: string[] } };
    const target = path.join(options.cwd!, context.task.ownedPaths[0]!);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${context.task.id}\n`);
    return { text: "implemented", profileName: "fake", usedFallback: false };
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

describe("wave rejection facts", () => {
  it("names the step, the attempts and the message a sibling died with", () => {
    const progress = waveTaskProgress();
    expect(progress.phase).toBe("worktree");
    progress.phase = "dependencies";

    const facts = waveRejectionFacts({
      taskId: "alpha",
      progress,
      task: { status: "working", attempts: 0 },
      durationMs: 742,
      error: new Error("fatal: could not create work tree dir"),
    });

    expect(facts).toEqual({
      taskId: "alpha",
      phase: "dependencies",
      status: "working",
      attempts: 0,
      durationMs: 742,
      error: "fatal: could not create work tree dir",
    });
  });

  it("keeps the tail of a long error instead of an unbounded one", () => {
    const facts = waveRejectionFacts({
      taskId: "beta",
      progress: waveTaskProgress(),
      task: { status: "working", attempts: 1 },
      durationMs: 5,
      error: new Error("x".repeat(900)),
    });
    expect(facts.error).toHaveLength(500);
    expect(facts.attempts).toBe(1);
  });

  it("adds the failure fields only when a wave lost a task", () => {
    const quiet = waveCompletionPayload({
      taskIds: ["alpha", "beta"],
      concurrency: 2,
      status: "merged",
      batchKeys: ["root"],
    });
    expect(quiet).toEqual({
      taskIds: ["alpha", "beta"],
      concurrency: 2,
      status: "merged",
      batchKeys: ["root"],
    });

    const loud = waveCompletionPayload({
      taskIds: ["alpha", "beta"],
      concurrency: 2,
      status: "blocked",
      batchKeys: ["root"],
      rejected: [
        {
          taskId: "alpha",
          phase: "worktree",
          status: "working",
          attempts: 0,
          durationMs: 12,
          error: "boom",
        },
      ],
      environment: { loadAverage: [1.5, 2, 3], competingProcesses: 4 },
    });
    expect(loud).toMatchObject({
      status: "blocked",
      rejected: [{ taskId: "alpha", phase: "worktree" }],
      environment: { competingProcesses: 4 },
    });
  });

  it("samples the machine without failing when it cannot look", async () => {
    const sample = await sampleWaveEnvironment(process.cwd());
    expect(sample.loadAverage).toHaveLength(3);
    expect(sample.loadAverage.every((value) => Number.isFinite(value))).toBe(true);
    expect(sample.competingProcesses === null || sample.competingProcesses >= 0).toBe(true);
  }, 30_000);
});

describe("a wave that loses a sibling", () => {
  it("says which task died where instead of dropping the failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-wave-rejection-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Agent Team Test"]);
    await git(root, ["config", "user.email", "agent-team@example.com"]);
    const config = createDefaultConfig("wave-rejection");
    config.quality.commands = [{ command: process.execPath, args: ["-e", "process.exit(0)"] }];
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const loaded = await loadConfig(root);
    const events: PendingRunEvent[] = [];
    const eventSink: RunEventSink = {
      append(event) {
        events.push(event);
        return { ...event, sequence: events.length, traceId: "trace", spanId: "span" };
      },
    };

    // The wave's agent factory dies before either task claims a worktree: exactly
    // the shape a slow machine produced under load, where one task never reached
    // its first attempt and the run could not say why.
    let factoryCalls = 0;
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => {
        factoryCalls += 1;
        // Planning asks for one service; the wave asks again, and that is where
        // this fixture's machine breaks.
        if (factoryCalls === 1) return new ShapeOnlyAgentService();
        throw new Error("agent factory is down");
      },
      eventSink,
    }).run({ goal: "Create alpha and beta files" });

    const completed = events.filter((event) => event.type === "run.wave.completed");
    const failed = completed.find(
      (event) => (event.payload as { status?: string }).status === "failed",
    );
    expect(failed, `events=${events.map((event) => event.type).join(",")}`).toBeDefined();

    const payload = failed!.payload as {
      rejected?: Array<{
        taskId: string;
        phase: string;
        attempts: number;
        durationMs: number;
        error: string;
      }>;
      environment?: { loadAverage: number[]; competingProcesses: number | null };
      error?: string;
    };

    expect(payload.rejected?.map((entry) => entry.taskId)).toEqual(["alpha", "beta"]);
    expect(payload.rejected?.every((entry) => entry.phase === "worktree")).toBe(true);
    expect(payload.rejected?.map((entry) => entry.attempts)).toEqual([0, 0]);
    expect(payload.rejected?.every((entry) => entry.durationMs >= 0)).toBe(true);
    expect(payload.rejected?.every((entry) => entry.error.includes("agent factory is down"))).toBe(
      true,
    );
    expect(payload.environment?.loadAverage).toHaveLength(3);
    expect(payload.error).toBe(payload.rejected?.[0]?.error);

    // The observation changes nothing about the outcome: a wave where nothing
    // passed still stops the run.
    expect(state.status).toBe("blocked");
    expect(state.tasks.every((task) => task.attempts === 0)).toBe(true);
  }, 60_000);
});
