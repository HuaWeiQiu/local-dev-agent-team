import { mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
import { RunStateStore } from "../src/state/store.js";
import { branchSegment } from "../src/workflow/id.js";
import { LocalWorkflowRunner } from "../src/workflow/runner.js";

class FakeAgentService implements RoleAgentService {
  async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
    let value: unknown;
    if (options.role === "orchestrator" && options.promptKey !== "orchestrator-final") {
      value = {
        goalSummary: "Create two files",
        instructionsForArchitect: "Split the files",
        constraints: [],
        risk: "low",
      };
    } else if (options.role === "architect") {
      value = {
        summary: "Two independent files",
        tasks: [
          {
            id: "alpha",
            title: "Alpha",
            description: "Create alpha.txt",
            dependsOn: [],
            ownedPaths: ["alpha.txt"],
            acceptanceCommands: [],
            profile: null,
          },
          {
            id: "beta",
            title: "Beta",
            description: "Create beta.txt",
            dependsOn: [],
            ownedPaths: ["beta.txt"],
            acceptanceCommands: [],
            profile: null,
          },
        ],
      };
    } else if (options.role === "reviewer") {
      value = { verdict: "approve", summary: "Looks correct", findings: [] };
    } else if (options.role === "tester") {
      value = { verdict: "approve", summary: "Covered", missingTests: [] };
    } else {
      value = { decision: "ready", reason: "All gates passed" };
    }
    return {
      value: options.schema.parse(value),
      profileName: "fake",
      usedFallback: false,
      text: JSON.stringify(value),
    };
  }

  async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
    const context = options.context as { task: { id: string; ownedPaths: string[] } };
    await writeFile(path.join(options.cwd!, context.task.ownedPaths[0]!), `${context.task.id}\n`);
    return { text: "implemented", profileName: "fake-worker", usedFallback: false };
  }
}

class AcceptanceCommandAgentService extends FakeAgentService {
  override async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
    if (options.role === "architect") {
      const value = {
        summary: "Two independent files",
        tasks: [
          {
            id: "alpha",
            title: "Alpha",
            description: "Create alpha.txt",
            dependsOn: [],
            ownedPaths: ["alpha.txt"],
            acceptanceCommands: [
              { command: process.execPath, args: ["-e", "process.exit(0)"] },
            ],
            profile: null,
          },
          {
            id: "beta",
            title: "Beta",
            description: "Create beta.txt",
            dependsOn: [],
            ownedPaths: ["beta.txt"],
            acceptanceCommands: [],
            profile: null,
          },
        ],
      };
      return {
        value: options.schema.parse(value),
        profileName: "fake",
        usedFallback: false,
        text: JSON.stringify(value),
      };
    }
    return super.runStructured(options);
  }
}

describe("local workflow", () => {
  it("runs a sequential topology through review, tests, and integration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-workflow-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Agent Team Test"]);
    await git(root, ["config", "user.email", "agent-team@example.com"]);
    const config = createDefaultConfig("fixture");
    config.project.maxParallel = 2;
    config.strategies!.definitions.strict = {
      topology: { mode: "sequential" },
      maxParallel: 1,
      maxReworkAttempts: 3,
      roleProfiles: { reviewer: "codex-planner" },
    };
    config.quality.commands = [
      { command: process.execPath, args: ["-e", "process.exit(0)"] },
    ];
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const loaded = await loadConfig(root);
    let resolvedProfileOverrides: Record<string, string> | undefined;
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: (_store, overrides) => {
        resolvedProfileOverrides = overrides;
        return new FakeAgentService();
      },
    }).run({
      goal: "Create alpha and beta files",
      strategyName: "strict",
      profileOverrides: { reviewer: "codex-planner" },
    });

    expect(state.status).toBe("awaiting-human");
    expect(state.strategy).toMatchObject({
      name: "strict",
      maxParallel: 1,
      maxReworkAttempts: 3,
      topology: { mode: "sequential" },
    });
    expect(resolvedProfileOverrides).toEqual({ reviewer: "codex-planner" });
    expect(state.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    expect(state.checkpoints?.map((checkpoint) => checkpoint.stage)).toEqual([
      "plan-ready",
      "task-wave-integrated",
      "task-wave-integrated",
      "tasks-complete",
      "local-gates-passed",
    ]);
    expect(state.approvals).toMatchObject([{ gate: "final", status: "pending" }]);
    expect(await readFile(path.join(state.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(await readFile(path.join(state.integrationWorktree, "beta.txt"), "utf8")).toBe(
      "beta\n",
    );
  }, 30_000);

  it("persists a terminal state when startup fails on a dirty primary worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-dirty-workflow-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Agent Team Test"]);
    await git(root, ["config", "user.email", "agent-team@example.com"]);
    const config = createDefaultConfig("dirty-fixture");
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);
    // leave the primary worktree dirty so startup must fail before the first save
    await writeFile(path.join(root, "README.md"), "# Dirty\n");

    const loaded = await loadConfig(root);
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
    }).run({ goal: "Must survive startup failure" });

    expect(state.status).toBe("blocked");
    expect(state.error).toContain("must be clean");

    // the run stays visible in the state store instead of vanishing
    const store = new RunStateStore(path.join(root, config.project.stateDirectory, "runs"));
    const persisted = await store.load(state.id);
    expect(persisted.status).toBe("blocked");
    expect(persisted.error).toContain("must be clean");
    expect((await store.list()).map((entry) => entry.id)).toContain(state.id);
  }, 30_000);

  it("persists CLI role bindings with their materialized profile names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-bindings-workflow-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Agent Team Test"]);
    await git(root, ["config", "user.email", "agent-team@example.com"]);
    const config = createDefaultConfig("bindings-fixture");
    config.quality.commands = [
      { command: process.execPath, args: ["-e", "process.exit(0)"] },
    ];
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const loaded = await loadConfig(root);
    const profileName = "runtime/reviewer/grok/grok-4/medium";
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
    }).run({
      goal: "Create alpha and beta files",
      profileOverrides: { reviewer: profileName },
      roleBindings: { reviewer: { cli: "grok", model: "grok-4", reasoning: "medium" } },
    });

    expect(state.roleBindings).toEqual({
      reviewer: { cli: "grok", model: "grok-4", reasoning: "medium", profileName },
    });
    const store = new RunStateStore(path.join(root, ".agent-team", "runs"));
    const reloaded = await store.load(state.id);
    expect(reloaded?.roleBindings).toEqual(state.roleBindings);
  }, 30_000);

  it("rehydrates runtime picker profiles on resume without a fake agent service", async () => {
    const { root, loaded } = await createFixture("runtime-resume");
    const store = new RunStateStore(path.join(root, ".agent-team", "runs"));
    const now = new Date().toISOString();
    const runId = "runtime-resume-run";
    const state = {
      id: runId,
      goal: "Continue after approval with desktop grok-4.6",
      root,
      configPath: path.join(root, "agent-team.yaml"),
      baseBranch: "main",
      baseCommit: (await gitOut(root, ["rev-parse", "HEAD"])).stdout.trim(),
      integrationBranch: `agent-team/${runId}/integration`,
      integrationWorktree: path.join(root, ".agent-team", "worktrees", runId, "integration"),
      status: "interrupted" as const,
      createdAt: now,
      updatedAt: now,
      profileOverrides: {
        worker: "runtime/worker/grok/grok-4.6/high",
      },
      strategy: {
        name: "balanced",
        maxParallel: 2,
        maxReworkAttempts: 2,
        executionTimeoutSeconds: 14_400,
        maxAgentInvocations: 64,
        maxProcessOutputBytes: 1_048_576,
        maxArtifactBytes: 1_073_741_824,
        roleProfiles: {},
        approvalGates: ["final"] as Array<"plan" | "final">,
        approvalTimeoutSeconds: 86_400,
      },
      tasks: [],
      history: [],
    };
    await store.save(state);
    expect(loaded.config.roles.worker!.allowedProfiles).not.toContain(
      "runtime/worker/grok/grok-4.6/high",
    );

    const resumed = await new LocalWorkflowRunner(loaded).resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Must keep the desktop grok-4.6 worker after restart",
    });

    expect(resumed.error ?? "").not.toContain("is not allowed for role");
    expect(loaded.config.roles.worker!.allowedProfiles).not.toContain(
      "runtime/worker/grok/grok-4.6/high",
    );
  }, 30_000);

  it("completes an isolated evolution evaluation after local gates without publication approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-evaluation-workflow-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Agent Team Test"]);
    await git(root, ["config", "user.email", "agent-team@example.com"]);
    const config = createDefaultConfig("evaluation-fixture");
    config.strategies!.definitions.balanced!.approvalGates = ["plan", "final"];
    config.quality.commands = [
      { command: process.execPath, args: ["-e", "process.exit(0)"] },
    ];
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "README.md"), "# Evaluation Fixture\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const state = await new LocalWorkflowRunner(await loadConfig(root), {
      createAgentService: () => new FakeAgentService(),
    }).run({
      goal: "Evaluate the strategy in an isolated worktree",
      purpose: "evolution-evaluation",
    });

    expect(state).toMatchObject({
      purpose: "evolution-evaluation",
      status: "completed",
      finalQuality: { passed: true },
      finalDecision: { decision: "ready" },
    });
    expect(state.approvals).toBeUndefined();
    expect(state.pullRequestUrl).toBeUndefined();
  }, 30_000);

  it("recovers only from a verified boundary and preserves abandoned task evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-recovery-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Agent Team Test"]);
    await git(root, ["config", "user.email", "agent-team@example.com"]);
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.guarded = {
      maxParallel: 2,
      maxReworkAttempts: 2,
      roleProfiles: {},
      approvalGates: ["plan", "final"],
      approvalTimeoutSeconds: 86_400,
    };
    config.quality.commands = [
      { command: process.execPath, args: ["-e", "process.exit(0)"] },
    ];
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const loaded = await loadConfig(root);
    const dependencies = {
      createAgentService: () => new FakeAgentService(),
    };
    const runner = new LocalWorkflowRunner(loaded, dependencies);
    const state = await runner.run({
      goal: "Recover alpha and beta files",
      strategyName: "guarded",
    });
    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.every((task) => task.status === "pending")).toBe(true);
    expect(state.approvals).toMatchObject([{ gate: "plan", status: "pending" }]);

    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Plan ownership reviewed",
      respondedAt: new Date().toISOString(),
    };
    state.status = "interrupted";
    state.tasks[0]!.status = "working";
    state.tasks[0]!.attempts = 1;
    state.tasks[0]!.branch = `agent-team/${state.id}/alpha`;
    state.tasks[0]!.worktree = path.join(root, ".agent-team", "worktrees", state.id, "alpha");
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const checkpoint = state.checkpoints!.at(-1)!;
    const integrationCommit = checkpoint.integrationCommit;
    checkpoint.integrationCommit = "does-not-match-integration-head";
    const refused = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Attempt recovery with stale evidence",
    });
    // Pre-execution validation failures keep the resumable status instead of
    // degrading the run to blocked.
    expect(refused.status).toBe("interrupted");
    expect(refused.error).toContain("does not match checkpoint");

    checkpoint.integrationCommit = integrationCommit;
    state.status = "interrupted";
    delete state.error;
    const uncheckpointedFile = path.join(state.integrationWorktree, "uncheckpointed.txt");
    await writeFile(uncheckpointedFile, "must not enter recovery\n");
    const dirtyRefused = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Attempt recovery with a dirty integration worktree",
    });
    expect(dirtyRefused.status).toBe("interrupted");
    expect(dirtyRefused.error).toContain("uncommitted changes outside the checkpoint");

    await unlink(uncheckpointedFile);
    state.status = "interrupted";
    delete state.error;
    const recovered = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Host restarted during the first worker wave",
    });
    expect(recovered.status).toBe("awaiting-human");
    expect(recovered.resumeCount).toBe(1);
    expect(recovered.recoveries).toMatchObject([
      {
        actor: "operator",
        abandonedTasks: [{ taskId: "alpha", status: "working", attempts: 1 }],
      },
    ]);
    expect(recovered.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    expect(recovered.tasks.every((task) => task.branch?.endsWith("-resume-1"))).toBe(true);
    expect(recovered.approvals?.at(-1)).toMatchObject({ gate: "final", status: "pending" });
    expect(await readFile(path.join(recovered.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
  }, 30_000);

  it("forces plan approval when any planned task defines acceptanceCommands", async () => {
    const { loaded } = await createFixture("acceptance-gate");
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => new AcceptanceCommandAgentService(),
    });
    // The default strategy gates only "final", but alpha carries
    // acceptanceCommands, so the plan itself must be approved first.
    const state = await runner.run({ goal: "Create alpha and beta files" });
    expect(state.status).toBe("awaiting-human");
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals![0]).toMatchObject({ gate: "plan", status: "pending" });
    expect(state.approvals![0]!.summary).toContain("acceptanceCommands");
    expect(state.approvals![0]!.summary).toContain("alpha");
    expect(state.tasks.every((task) => task.status === "pending")).toBe(true);

    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Acceptance commands reviewed",
      respondedAt: new Date().toISOString(),
    };
    const continued = await runner.resume(state, {
      mode: "approval",
      actor: "tech-lead",
      reason: "Plan approved",
    });
    expect(continued.status).toBe("awaiting-human");
    expect(continued.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    expect(continued.approvals?.at(-1)).toMatchObject({ gate: "final", status: "pending" });
  }, 30_000);

  it("propagates budget exhaustion instead of spinning it into rework attempts", async () => {
    const { root, loaded } = await createFixture("budget", (config) => {
      config.strategies!.definitions.budgeted = {
        maxParallel: 2,
        maxReworkAttempts: 2,
        roleProfiles: {},
        approvalGates: ["final"],
        maxProcessOutputBytes: 10_485_760,
        maxArtifactBytes: 1_048_576,
      };
      // Each quality run writes ~3MB of artifacts, blowing the 1MB artifact
      // budget on the first recordQuality call.
      config.quality.commands = [
        { command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(3_000_000))"] },
      ];
    });
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
    }).run({ goal: "Create alpha and beta files", strategyName: "budgeted" });

    expect(state.status).toBe("blocked");
    expect(state.error).toContain("Artifact budget");
    expect(state.error).not.toContain("Exceeded");

    // Terminal cleanup removed task worktrees and branches but kept the
    // integration worktree/branch untouched.
    const worktrees = await readdir(path.join(root, ".agent-team", "worktrees", state.id));
    expect(worktrees).toEqual(["integration"]);
    const branches = (
      await gitOut(root, ["branch", "--list", "--format=%(refname:short)", "agent-team/*"])
    ).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(branches).toEqual([state.integrationBranch]);
  }, 60_000);

  it("aborts sibling tasks when a wave task fails hard", async () => {
    const { loaded } = await createFixture("wave-abort", (config) => {
      config.strategies!.definitions.swarm = {
        maxParallel: 2,
        maxReworkAttempts: 1,
        roleProfiles: {},
        approvalGates: ["final"],
        maxProcessOutputBytes: 10_485_760,
        maxArtifactBytes: 1_048_576,
      };
      // Beta blows the artifact budget during its quality gates — a hard
      // failure that must abort alpha's in-flight agent invocation.
      config.quality.commands = [
        { command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(3_000_000))"] },
      ];
    });

    const events: PendingRunEvent[] = [];
    const eventSink: RunEventSink = {
      append(event) {
        events.push(event);
        return { ...event, sequence: events.length, traceId: "trace", spanId: "span" };
      },
    };
    let waveSignal: AbortSignal | undefined;
    let alphaAborted = false;
    class BlockingAgentService extends FakeAgentService {
      override async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
        const context = options.context as { task: { id: string } };
        if (context.task.id === "alpha") {
          await new Promise<never>((_, reject) => {
            const onAbort = (): void => {
              alphaAborted = true;
              reject(
                waveSignal?.reason instanceof Error
                  ? waveSignal.reason
                  : new Error("wave aborted"),
              );
            };
            if (waveSignal?.aborted) {
              onAbort();
            } else {
              waveSignal?.addEventListener("abort", onAbort, { once: true });
            }
          });
        }
        return super.runText(options);
      }
    }
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: (_store, _overrides, signal) => {
        waveSignal = signal;
        return new BlockingAgentService();
      },
      eventSink,
    }).run({ goal: "Create alpha and beta files", strategyName: "swarm" });

    expect(state.status).toBe("blocked");
    expect(state.error).toContain("Artifact budget");
    expect(alphaAborted).toBe(true);
    // Alpha was aborted mid-flight, never merged.
    expect(state.tasks.find((task) => task.task.id === "alpha")?.status).not.toBe("merged");
    const waveEvents = events.filter((event) => event.type === "run.wave.completed");
    expect(waveEvents).toHaveLength(1);
    expect(waveEvents[0]!.payload).toMatchObject({ status: "failed" });
  }, 30_000);

  it("keeps tasks merged after the latest checkpoint as completed during recovery", async () => {
    const { root, loaded } = await createFixture("merged-recovery", (config) => {
      config.strategies!.definitions.guarded = {
        maxParallel: 2,
        maxReworkAttempts: 2,
        roleProfiles: {},
        approvalGates: ["plan", "final"],
        approvalTimeoutSeconds: 86_400,
      };
    });
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
    });
    const state = await runner.run({ goal: "Recover merged alpha", strategyName: "guarded" });
    expect(state.status).toBe("awaiting-human");
    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Plan ownership reviewed",
      respondedAt: new Date().toISOString(),
    };

    // Simulate a crash mid-integration: alpha's commit is merged into the
    // integration branch and the task is marked merged, but the wave
    // checkpoint (and its completedTaskIds) never caught up.
    const segment = branchSegment(state.id);
    const alphaBranch = `agent-team/${segment}/alpha`;
    const alphaWorktree = path.join(root, ".agent-team", "worktrees", state.id, "alpha");
    const checkpoint = state.checkpoints!.at(-1)!;
    await git(root, ["worktree", "add", "-b", alphaBranch, alphaWorktree, checkpoint.integrationCommit]);
    await writeFile(path.join(alphaWorktree, "alpha.txt"), "alpha\n");
    await git(alphaWorktree, ["add", "alpha.txt"]);
    await git(alphaWorktree, ["commit", "-m", "agent: alpha"]);
    const alphaCommit = (await gitOut(alphaWorktree, ["rev-parse", "HEAD"])).stdout.trim();
    await git(state.integrationWorktree, ["merge", "--no-ff", alphaBranch, "-m", "merge: alpha"]);
    await git(root, ["worktree", "remove", "--force", alphaWorktree]);
    const head = (await gitOut(state.integrationWorktree, ["rev-parse", "HEAD"])).stdout.trim();

    state.status = "interrupted";
    state.tasks[0]!.status = "merged";
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.commit = alphaCommit;
    state.tasks[1]!.status = "working";
    state.tasks[1]!.attempts = 1;
    state.tasks[1]!.branch = `agent-team/${segment}/beta`;
    state.tasks[1]!.worktree = path.join(root, ".agent-team", "worktrees", state.id, "beta");
    checkpoint.integrationCommit = head;
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const recovered = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Host crashed mid-integration",
    });

    expect(recovered.status).toBe("awaiting-human");
    expect(recovered.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    // Alpha was already merged: it is neither abandoned nor re-executed.
    expect(recovered.tasks[0]!.branch).toBe(alphaBranch);
    expect(recovered.tasks[1]!.branch).toContain("-resume-1");
    expect(recovered.recoveries).toMatchObject([
      { actor: "operator", abandonedTasks: [{ taskId: "beta", status: "working", attempts: 1 }] },
    ]);
    expect(await readFile(path.join(recovered.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(await readFile(path.join(recovered.integrationWorktree, "beta.txt"), "utf8")).toBe(
      "beta\n",
    );
  }, 30_000);

  it("resumes when HEAD is ahead of the checkpoint by exactly the recorded merge commits", async () => {
    const { root, loaded } = await createFixture("post-merge-crash", (config) => {
      config.strategies!.definitions.guarded = {
        maxParallel: 2,
        maxReworkAttempts: 2,
        roleProfiles: {},
        approvalGates: ["plan", "final"],
        approvalTimeoutSeconds: 86_400,
      };
    });
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
    });
    const state = await runner.run({ goal: "Recover merged alpha", strategyName: "guarded" });
    expect(state.status).toBe("awaiting-human");
    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Plan ownership reviewed",
      respondedAt: new Date().toISOString(),
    };

    // Simulate a crash after alpha's merge but before the wave checkpoint:
    // integration HEAD moved ahead of checkpoint.integrationCommit, and the
    // merge commit was recorded on the task state.
    const segment = branchSegment(state.id);
    const alphaBranch = `agent-team/${segment}/alpha`;
    const alphaWorktree = path.join(root, ".agent-team", "worktrees", state.id, "alpha");
    const checkpoint = state.checkpoints!.at(-1)!;
    await git(root, ["worktree", "add", "-b", alphaBranch, alphaWorktree, checkpoint.integrationCommit]);
    await writeFile(path.join(alphaWorktree, "alpha.txt"), "alpha\n");
    await git(alphaWorktree, ["add", "alpha.txt"]);
    await git(alphaWorktree, ["commit", "-m", "agent: alpha"]);
    await git(state.integrationWorktree, ["merge", "--no-ff", alphaBranch, "-m", "merge: alpha"]);
    await git(root, ["worktree", "remove", "--force", alphaWorktree]);
    const mergeHead = (await gitOut(state.integrationWorktree, ["rev-parse", "HEAD"])).stdout.trim();
    expect(mergeHead).not.toBe(checkpoint.integrationCommit);

    state.status = "interrupted";
    state.tasks[0]!.status = "merged";
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.mergeCommit = mergeHead;
    state.tasks[1]!.status = "working";
    state.tasks[1]!.attempts = 1;
    state.tasks[1]!.branch = `agent-team/${segment}/beta`;
    state.tasks[1]!.worktree = path.join(root, ".agent-team", "worktrees", state.id, "beta");
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const recovered = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Host crashed after merge before the wave checkpoint",
    });

    expect(recovered.status).toBe("awaiting-human");
    expect(recovered.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    // Alpha's merge is trusted, not redone; beta is re-executed.
    expect(recovered.tasks[0]!.branch).toBe(alphaBranch);
    expect(recovered.tasks[1]!.branch).toContain("-resume-1");
    expect(recovered.recoveries).toMatchObject([
      { actor: "operator", abandonedTasks: [{ taskId: "beta", status: "working", attempts: 1 }] },
    ]);
    expect(await readFile(path.join(recovered.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(await readFile(path.join(recovered.integrationWorktree, "beta.txt"), "utf8")).toBe(
      "beta\n",
    );
  }, 30_000);

  it("still refuses recovery when the post-checkpoint HEAD contains foreign commits", async () => {
    const { root, loaded } = await createFixture("foreign-head", (config) => {
      config.strategies!.definitions.guarded = {
        maxParallel: 2,
        maxReworkAttempts: 2,
        roleProfiles: {},
        approvalGates: ["plan", "final"],
        approvalTimeoutSeconds: 86_400,
      };
    });
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
    });
    const state = await runner.run({ goal: "Reject foreign commits", strategyName: "guarded" });
    expect(state.status).toBe("awaiting-human");
    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Plan ownership reviewed",
      respondedAt: new Date().toISOString(),
    };

    const segment = branchSegment(state.id);
    const alphaBranch = `agent-team/${segment}/alpha`;
    const alphaWorktree = path.join(root, ".agent-team", "worktrees", state.id, "alpha");
    const checkpoint = state.checkpoints!.at(-1)!;
    await git(root, ["worktree", "add", "-b", alphaBranch, alphaWorktree, checkpoint.integrationCommit]);
    await writeFile(path.join(alphaWorktree, "alpha.txt"), "alpha\n");
    await git(alphaWorktree, ["add", "alpha.txt"]);
    await git(alphaWorktree, ["commit", "-m", "agent: alpha"]);
    await git(state.integrationWorktree, ["merge", "--no-ff", alphaBranch, "-m", "merge: alpha"]);
    await git(root, ["worktree", "remove", "--force", alphaWorktree]);
    const mergeHead = (await gitOut(state.integrationWorktree, ["rev-parse", "HEAD"])).stdout.trim();
    // A commit the orchestrator never produced lands on the integration branch.
    await writeFile(path.join(state.integrationWorktree, "foreign.txt"), "foreign\n");
    await git(state.integrationWorktree, ["add", "foreign.txt"]);
    await git(state.integrationWorktree, ["commit", "-m", "foreign commit"]);

    state.status = "interrupted";
    state.tasks[0]!.status = "merged";
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.mergeCommit = mergeHead;
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const refused = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Attempt recovery with foreign commits on the integration branch",
    });
    expect(refused.status).toBe("interrupted");
    expect(refused.error).toContain("does not match checkpoint");
  }, 30_000);
});

async function createFixture(
  name: string,
  configure?: (config: ReturnType<typeof createDefaultConfig>) => void,
): Promise<{ root: string; loaded: Awaited<ReturnType<typeof loadConfig>> }> {
  const root = await mkdtemp(path.join(tmpdir(), `agent-team-${name}-`));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Agent Team Test"]);
  await git(root, ["config", "user.email", "agent-team@example.com"]);
  const config = createDefaultConfig(name);
  config.quality.commands = [{ command: process.execPath, args: ["-e", "process.exit(0)"] }];
  configure?.(config);
  await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return { root, loaded: await loadConfig(root) };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitOut(cwd, args);
}

async function gitOut(cwd: string, args: string[]) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  return result;
}
