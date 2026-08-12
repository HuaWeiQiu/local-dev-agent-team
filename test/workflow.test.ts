import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
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
import { runProcess } from "../src/process/run.js";
import { RunStateStore } from "../src/state/store.js";
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
    expect(refused.status).toBe("blocked");
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
    expect(dirtyRefused.status).toBe("blocked");
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
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
}
