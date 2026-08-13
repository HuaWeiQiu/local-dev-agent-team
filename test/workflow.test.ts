import { access, mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
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
import type { RunState } from "../src/state/types.js";
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
    const target = path.join(options.cwd!, context.task.ownedPaths[0]!);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${context.task.id}\n`);
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

  it("does not force plan approval just because tasks define acceptanceCommands", async () => {
    const { loaded } = await createFixture("acceptance-gate");
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => new AcceptanceCommandAgentService(),
    });
    const state = await runner.run({ goal: "Create alpha and beta files" });
    expect(state.status).toBe("awaiting-human");
    expect(state.approvals?.at(-1)).toMatchObject({ gate: "final", status: "pending" });
    expect(state.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
  }, 30_000);

  it("builds a deterministic DAG from named paths without calling the architect", async () => {
    class FailIfArchitectService extends FakeAgentService {
      override async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
        if (options.role === "architect") {
          throw new Error("architect should not run when the goal already names paths");
        }
        return super.runStructured(options);
      }
    }
    const { loaded } = await createFixture("named-paths");
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FailIfArchitectService(),
    }).run({
      goal: "Implement T1-T3. T1 add src/greet.js. T2 add test/greet.test.js. T3 write CHANGELOG.md.",
    });
    expect(state.status).toBe("awaiting-human");
    expect(state.plan?.summary).toContain("Deterministic DAG");
    expect(state.tasks.map((task) => task.task.id)).toEqual(["T1", "T2", "T3"]);
    expect(state.tasks.map((task) => task.status)).toEqual(["merged", "merged", "merged"]);
    expect(state.history.some((entry) => entry.message.includes("不调用架构模型"))).toBe(true);
  }, 30_000);

  it("applies the plan gate to controller-produced DAGs and resumes after approval", async () => {
    class CountWorkerCallsService extends FakeAgentService {
      workerCalls = 0;
      override async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
        this.workerCalls += 1;
        return super.runText(options);
      }
    }
    const { loaded } = await createFixture("named-paths-plan-gate", (config) => {
      config.strategies!.definitions.guarded = {
        maxParallel: 2,
        maxReworkAttempts: 2,
        roleProfiles: {},
        approvalGates: ["plan", "final"],
        approvalTimeoutSeconds: 86_400,
      };
    });
    const service = new CountWorkerCallsService();
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => service,
    });
    const state = await runner.run({
      goal: "Implement T1-T3. T1 add src/greet.js. T2 add test/greet.test.js. T3 write CHANGELOG.md.",
      strategyName: "guarded",
    });

    // The plan gate must stop the deterministic path before any worker runs.
    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.map((task) => task.status)).toEqual(["pending", "pending", "pending"]);
    expect(service.workerCalls).toBe(0);
    expect(state.approvals?.at(-1)).toMatchObject({ gate: "plan", status: "pending" });
    expect(state.checkpoints?.at(-1)?.stage).toBe("plan-ready");

    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Plan ownership reviewed",
      respondedAt: new Date().toISOString(),
    };
    const continued = await runner.resume(state, {
      mode: "approval",
      actor: "tech-lead",
      reason: "Plan approved",
    });

    expect(continued.status).toBe("awaiting-human");
    expect(continued.tasks.map((task) => task.status)).toEqual(["merged", "merged", "merged"]);
    expect(continued.approvals?.at(-1)).toMatchObject({ gate: "final", status: "pending" });
  }, 30_000);

  it("keeps merged work when a sibling docs task blocks", async () => {
    class ChangelogFailAgentService extends FakeAgentService {
      override async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
        const context = options.context as { task: { id: string; ownedPaths: string[] } };
        if (context.task.id === "T3") {
          throw new Error("changelog worker cancelled");
        }
        return super.runText(options);
      }
    }
    const { loaded } = await createFixture("partial-success", (config) => {
      config.strategies!.definitions.demo = {
        maxParallel: 2,
        maxReworkAttempts: 0,
        roleProfiles: {},
        approvalGates: ["final"],
      };
    });
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new ChangelogFailAgentService(),
    }).run({
      goal: "Implement T1-T3. T1 add src/greet.js. T2 add test/greet.test.js. T3 write CHANGELOG.md.",
      strategyName: "demo",
    });
    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ["T1", "merged"],
      ["T2", "merged"],
      ["T3", "blocked"],
    ]);
    expect(state.approvals?.at(-1)?.summary).toContain("T3 remain blocked");
    expect(await readFile(path.join(state.integrationWorktree, "src/greet.js"), "utf8")).toBe("T1\n");
    expect(await readFile(path.join(state.integrationWorktree, "test/greet.test.js"), "utf8")).toBe("T2\n");
  }, 30_000);

  it("accepts a docs task when quality passed and specialists escalate", async () => {
    class DocsEscalateAgentService extends FakeAgentService {
      override async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
        if (options.role === "reviewer" || options.role === "tester") {
          const task = (options.context as { task: { ownedPaths: string[] } }).task;
          const docs = task.ownedPaths.every((item) => item.endsWith(".md"));
          if (docs) {
            const value = options.role === "reviewer"
              ? { verdict: "escalate", summary: "Need host evidence", findings: [] }
              : { verdict: "escalate", summary: "Need more tests", missingTests: ["host"] };
            return {
              value: options.schema.parse(value),
              profileName: "fake",
              usedFallback: false,
              text: JSON.stringify(value),
            };
          }
        }
        return super.runStructured(options);
      }
    }
    const { loaded } = await createFixture("docs-escalate");
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new DocsEscalateAgentService(),
    }).run({
      goal: "Implement T1-T2. T1 add src/greet.js. T2 write CHANGELOG.md.",
    });
    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ["T1", "merged"],
      ["T2", "merged"],
    ]);
    expect(state.tasks[1]?.review?.verdict).toBe("escalate");
    expect(await readFile(path.join(state.integrationWorktree, "CHANGELOG.md"), "utf8")).toBe("T2\n");
  }, 30_000);

  it("does not let a final escalate veto merged work when quality passed", async () => {
    class PartialEscalateFinalService extends FakeAgentService {
      override async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
        const context = options.context as { task: { id: string } };
        if (context.task.id === "T3") {
          throw new Error("changelog worker cancelled");
        }
        return super.runText(options);
      }

      override async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
        if (options.role === "orchestrator" && options.promptKey === "orchestrator-final") {
          const value = { decision: "escalate", reason: "T3 is blocked" };
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
    const { loaded } = await createFixture("partial-final", (config) => {
      config.strategies!.definitions.demo = {
        maxParallel: 2,
        maxReworkAttempts: 0,
        roleProfiles: {},
        approvalGates: ["final"],
      };
    });
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new PartialEscalateFinalService(),
    }).run({
      goal: "Implement T1-T3. T1 add src/greet.js. T2 add test/greet.test.js. T3 write CHANGELOG.md.",
      strategyName: "demo",
    });
    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.filter((task) => task.status === "merged").map((task) => task.task.id)).toEqual([
      "T1",
      "T2",
    ]);
    expect(state.history.some((entry) => entry.message.includes("终裁 escalate 已降级"))).toBe(true);
  }, 30_000);

  it("does not let a final escalate veto when every task already merged", async () => {
    class AllMergedEscalateFinalService extends FakeAgentService {
      override async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
        const context = options.context as { task?: { id?: string } };
        if (options.role === "reviewer" && context.task?.id === "T1") {
          const value = {
            verdict: "escalate",
            summary: "Need to inspect the actual file independently before issuing a verdict.",
            findings: [],
          };
          return {
            value: options.schema.parse(value),
            profileName: "fake",
            usedFallback: false,
            text: JSON.stringify(value),
          };
        }
        if (options.role === "orchestrator" && options.promptKey === "orchestrator-final") {
          const value = {
            decision: "escalate",
            reason: "T1 independent review verdict is escalate, so the run cannot be declared ready",
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
    const { loaded } = await createFixture("all-merged-final", (config) => {
      config.strategies!.definitions.demo = {
        maxParallel: 2,
        maxReworkAttempts: 0,
        roleProfiles: {},
        approvalGates: ["final"],
      };
    });
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new AllMergedEscalateFinalService(),
    }).run({
      goal: "Implement T1-T3. T1 add src/greet.js. T2 add test/greet.test.js. T3 write CHANGELOG.md.",
      strategyName: "demo",
    });
    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.map((task) => [task.task.id, task.status])).toEqual([
      ["T1", "merged"],
      ["T2", "merged"],
      ["T3", "merged"],
    ]);
    expect(state.history.some((entry) => entry.message.includes("终裁 escalate 已降级"))).toBe(true);
  }, 30_000);

  it("rejects an incomplete architect plan before approval or work starts", async () => {
    class ThinPlanAgentService extends FakeAgentService {
      override async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
        if (options.role === "architect") {
          const value = {
            summary: "Read the handover first",
            tasks: [
              {
                id: "inspect-handoff",
                title: "Inspect handover",
                description: "read-only inspect of the handover",
                dependsOn: [],
                ownedPaths: ["docs/HANDOFF.md"],
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
    const { loaded } = await createFixture("thin-plan");
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new ThinPlanAgentService(),
    }).run({ goal: "Implement T1-T4 from the handover" });
    expect(state.status).toBe("blocked");
    expect(state.error).toContain("Plan completeness rejected");
    expect(state.error).toContain("缺 T1");
    expect(state.tasks).toEqual([]);
    expect(state.approvals ?? []).toEqual([]);
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

  it("keeps sibling tasks running when a wave task fails hard", async () => {
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
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
      eventSink,
    }).run({ goal: "Create alpha and beta files", strategyName: "swarm" });

    expect(state.status).toBe("blocked");
    expect(state.error).toContain("Artifact budget");
    const waveEvents = events.filter((event) => event.type === "run.wave.completed");
    expect(waveEvents.length).toBeGreaterThan(0);
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

  it("recovers a merge whose state save crashed after git.merge", async () => {
    const { root, loaded } = await createFixture("merge-save-crash", (config) => {
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
    const state = await runner.run({ goal: "Recover unsaved merge", strategyName: "guarded" });
    expect(state.status).toBe("awaiting-human");
    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Plan ownership reviewed",
      respondedAt: new Date().toISOString(),
    };

    // Simulate a crash between git.merge and the state save: the merge commit
    // is in the integration branch, the task still reads "passed", the
    // `merging` intent marker was persisted, and the worktree is already gone.
    const segment = branchSegment(state.id);
    const alphaBranch = `agent-team/${segment}/alpha`;
    const alphaWorktree = path.join(root, ".agent-team", "worktrees", state.id, "alpha");
    const checkpoint = state.checkpoints!.at(-1)!;
    await git(root, ["worktree", "add", "-b", alphaBranch, alphaWorktree, checkpoint.integrationCommit]);
    await writeFile(path.join(alphaWorktree, "alpha.txt"), "alpha\n");
    await git(alphaWorktree, ["add", "alpha.txt"]);
    await git(alphaWorktree, ["commit", "-m", "agent: alpha"]);
    const alphaCommit = (await gitOut(alphaWorktree, ["rev-parse", "HEAD"])).stdout.trim();
    await git(state.integrationWorktree, ["merge", "--no-ff", alphaBranch, "-m", "merge: alpha Alpha"]);
    await git(root, ["worktree", "remove", "--force", alphaWorktree]);
    const mergeHead = (await gitOut(state.integrationWorktree, ["rev-parse", "HEAD"])).stdout.trim();

    state.status = "interrupted";
    state.tasks[0]!.status = "passed";
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.commit = alphaCommit;
    state.tasks[0]!.merging = alphaBranch;
    state.tasks[1]!.status = "working";
    state.tasks[1]!.attempts = 1;
    state.tasks[1]!.branch = `agent-team/${segment}/beta`;
    state.tasks[1]!.worktree = path.join(root, ".agent-team", "worktrees", state.id, "beta");
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const recovered = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Host crashed between the alpha merge and the state save",
    });

    expect(recovered.status).toBe("awaiting-human");
    expect(recovered.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    // Alpha's merge is recovered from the deterministic commit subject, not redone.
    expect(recovered.tasks[0]!.mergeCommit).toBe(mergeHead);
    expect(recovered.tasks[0]!.merging).toBeUndefined();
    expect(recovered.tasks[1]!.branch).toContain("-resume-1");
    expect(await readFile(path.join(recovered.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(await readFile(path.join(recovered.integrationWorktree, "beta.txt"), "utf8")).toBe(
      "beta\n",
    );
  }, 30_000);

  it("clears a stale merging marker when the crash happened before git.merge", async () => {
    const { root, loaded } = await createFixture("pre-merge-crash", (config) => {
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
    const state = await runner.run({ goal: "Recover pre-merge crash", strategyName: "guarded" });
    expect(state.status).toBe("awaiting-human");
    state.approvals![0]!.status = "approved";
    state.approvals![0]!.response = {
      decision: "approved",
      actor: "tech-lead",
      reason: "Plan ownership reviewed",
      respondedAt: new Date().toISOString(),
    };

    // Crash after the intent save but before git.merge: the marker exists,
    // the merge commit does not, and the task worktree is still present.
    const segment = branchSegment(state.id);
    const alphaBranch = `agent-team/${segment}/alpha`;
    const alphaWorktree = path.join(root, ".agent-team", "worktrees", state.id, "alpha");
    const checkpoint = state.checkpoints!.at(-1)!;
    await git(root, ["worktree", "add", "-b", alphaBranch, alphaWorktree, checkpoint.integrationCommit]);
    await writeFile(path.join(alphaWorktree, "alpha.txt"), "alpha\n");
    await git(alphaWorktree, ["add", "alpha.txt"]);
    await git(alphaWorktree, ["commit", "-m", "agent: alpha"]);
    const alphaCommit = (await gitOut(alphaWorktree, ["rev-parse", "HEAD"])).stdout.trim();

    state.status = "interrupted";
    state.tasks[0]!.status = "passed";
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.commit = alphaCommit;
    state.tasks[0]!.merging = alphaBranch;
    state.tasks[1]!.status = "working";
    state.tasks[1]!.attempts = 1;
    state.tasks[1]!.branch = `agent-team/${segment}/beta`;
    state.tasks[1]!.worktree = path.join(root, ".agent-team", "worktrees", state.id, "beta");
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const recovered = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Host crashed after the merge intent save",
    });

    expect(recovered.status).toBe("awaiting-human");
    expect(recovered.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    // The stale marker is cleared and alpha merges through the normal path.
    expect(recovered.tasks[0]!.merging).toBeUndefined();
    expect(recovered.tasks[0]!.mergeCommit).toBeTypeOf("string");
    expect(await readFile(path.join(recovered.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(await readFile(path.join(recovered.integrationWorktree, "beta.txt"), "utf8")).toBe(
      "beta\n",
    );
  }, 30_000);

  it("refuses a forged merge subject that does not point at the recorded task commit", async () => {
    const { root, loaded } = await createFixture("forged-subject", (config) => {
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
    const state = await runner.run({ goal: "Reject forged merge", strategyName: "guarded" });
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
    const alphaCommit = (await gitOut(alphaWorktree, ["rev-parse", "HEAD"])).stdout.trim();
    // A foreign single-parent commit that reuses the deterministic subject:
    // it must never be accepted as the task's merge.
    await writeFile(path.join(state.integrationWorktree, "forged.txt"), "forged\n");
    await git(state.integrationWorktree, ["add", "forged.txt"]);
    await git(state.integrationWorktree, ["commit", "-m", "merge: alpha Alpha"]);

    state.status = "interrupted";
    state.tasks[0]!.status = "passed";
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.commit = alphaCommit;
    state.tasks[0]!.merging = alphaBranch;
    state.tasks[1]!.status = "working";
    state.tasks[1]!.attempts = 1;
    state.tasks[1]!.branch = `agent-team/${segment}/beta`;
    state.tasks[1]!.worktree = path.join(root, ".agent-team", "worktrees", state.id, "beta");
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const refused = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Attempt recovery with a forged merge subject",
    });
    expect(refused.status).toBe("interrupted");
    expect(refused.error).toContain("does not point at the recorded task commit");
  }, 30_000);

  it("pauses into a resumable interrupted state and keeps the task worktree", async () => {
    const { root, loaded } = await createFixture("pause-runner", (config) => {
      config.strategies!.definitions.guarded = {
        maxParallel: 1,
        maxReworkAttempts: 0,
        roleProfiles: {},
        approvalGates: ["final"],
      };
    });
    class BlockingAgentService extends FakeAgentService {
      workflowSignal?: AbortSignal;
      override async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
        const context = options.context as { task: { id: string; ownedPaths: string[] } };
        const target = path.join(options.cwd!, context.task.ownedPaths[0]!);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${context.task.id}\n`);
        // Block like a long-running worker until the workflow signal aborts.
        await new Promise<void>((resolve) => {
          if (this.workflowSignal?.aborted) {
            resolve();
            return;
          }
          this.workflowSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "implemented", profileName: "fake-worker", usedFallback: false };
      }
    }
    const controller = new AbortController();
    const service = new BlockingAgentService();
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: (_store, _overrides, signal) => {
        service.workflowSignal = signal;
        return service;
      },
    });
    const running = runner.run({
      goal: "Create alpha and beta files",
      strategyName: "guarded",
      signal: controller.signal,
    });
    // Wait until the first wave is mid-execution with a persisted worktree.
    const store = new RunStateStore(path.join(root, ".agent-team", "runs"));
    let current: RunState | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const states = await store.list();
      current = states.find(
        (state) => state.status === "implementing" && state.tasks.some((task) => task.status === "working" && task.worktree),
      );
      if (current) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(current).toBeDefined();
    const worktree = current!.tasks.find((task) => task.status === "working")!.worktree!;
    expect(await pathExists(worktree)).toBe(true);

    // The supervisor aborts the workflow with the deterministic pause message.
    controller.abort(new Error("Run paused by user"));

    const settled = await running;
    expect(settled.status).toBe("interrupted");
    expect(settled.error).toContain("paused");
    // The task worktree survives the pause so resume can reuse the work.
    expect(await pathExists(worktree)).toBe(true);
    expect(settled.history.some((entry) => entry.status === "interrupted")).toBe(true);
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

  it("resumes a quality-passed task by reviewing or merging instead of redoing worker work", async () => {
    const { root, loaded } = await createFixture("reuse-passed", (config) => {
      config.strategies!.definitions.guarded = {
        maxParallel: 2,
        maxReworkAttempts: 2,
        roleProfiles: {},
        approvalGates: ["plan", "final"],
        approvalTimeoutSeconds: 86_400,
      };
    });
    let workerCalls = 0;
    class CountingAgentService extends FakeAgentService {
      override async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
        workerCalls += 1;
        return super.runText(options);
      }
    }
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => new CountingAgentService(),
    });
    const state = await runner.run({
      goal: "Create alpha and beta files",
      strategyName: "guarded",
    });
    expect(state.status).toBe("awaiting-human");
    expect(workerCalls).toBe(0);
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
    const commit = (await gitOut(alphaWorktree, ["rev-parse", "HEAD"])).stdout.trim();

    state.status = "interrupted";
    state.tasks[0]!.status = "passed";
    state.tasks[0]!.attempts = 1;
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.commit = commit;
    state.tasks[0]!.quality = {
      passed: true,
      commands: [{ spec: { command: process.execPath, args: ["-e", "process.exit(0)"] }, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }],
    };
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const recovered = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Control service stopped after quality passed",
    });
    expect(recovered.status).toBe("awaiting-human");
    expect(recovered.tasks[0]).toMatchObject({ status: "merged", commit });
    expect(recovered.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    expect(recovered.recoveries?.at(-1)?.abandonedTasks).toEqual([]);
    expect(workerCalls).toBe(1);
    expect(await readFile(path.join(recovered.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
  }, 30_000);

  it("resumes a quality-passed reviewing task without rerunning the worker", async () => {
    const { root, loaded } = await createFixture("reuse-review", (config) => {
      config.strategies!.definitions.guarded = {
        maxParallel: 2,
        maxReworkAttempts: 2,
        roleProfiles: {},
        approvalGates: ["plan", "final"],
        approvalTimeoutSeconds: 86_400,
      };
    });
    let workerCalls = 0;
    class CountingAgentService extends FakeAgentService {
      override async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
        workerCalls += 1;
        return super.runText(options);
      }
    }
    const runner = new LocalWorkflowRunner(loaded, {
      createAgentService: () => new CountingAgentService(),
    });
    const state = await runner.run({
      goal: "Create alpha and beta files",
      strategyName: "guarded",
    });
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

    state.status = "interrupted";
    state.tasks[0]!.status = "working";
    state.tasks[0]!.attempts = 1;
    state.tasks[0]!.branch = alphaBranch;
    state.tasks[0]!.worktree = alphaWorktree;
    state.tasks[0]!.quality = {
      passed: true,
      commands: [{ spec: { command: process.execPath, args: ["-e", "process.exit(0)"] }, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }],
    };
    await new RunStateStore(path.join(root, ".agent-team", "runs")).save(state);

    const recovered = await runner.resume(state, {
      mode: "recovery",
      actor: "operator",
      reason: "Control service stopped during review",
    });
    expect(recovered.status).toBe("awaiting-human");
    expect(recovered.tasks[0]?.status).toBe("merged");
    expect(recovered.recoveries?.at(-1)?.abandonedTasks).toEqual([]);
    expect(workerCalls).toBe(1);
    expect(await readFile(path.join(recovered.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
