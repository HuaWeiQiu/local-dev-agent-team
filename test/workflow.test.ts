import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  it("runs parallel workers through review, tests, and integration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-workflow-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.name", "Agent Team Test"]);
    await git(root, ["config", "user.email", "agent-team@example.com"]);
    const config = createDefaultConfig("fixture");
    config.project.maxParallel = 2;
    config.quality.commands = [
      { command: process.execPath, args: ["-e", "process.exit(0)"] },
    ];
    await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
    await writeFile(path.join(root, "README.md"), "# Fixture\n");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const loaded = await loadConfig(root);
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new FakeAgentService(),
    }).run({ goal: "Create alpha and beta files" });

    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.map((task) => task.status)).toEqual(["merged", "merged"]);
    expect(await readFile(path.join(state.integrationWorktree, "alpha.txt"), "utf8")).toBe(
      "alpha\n",
    );
    expect(await readFile(path.join(state.integrationWorktree, "beta.txt"), "utf8")).toBe(
      "beta\n",
    );
  }, 30_000);
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
}
