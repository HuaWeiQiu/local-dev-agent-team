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
import type { PendingRunEvent, RunEvent, RunEventSink } from "../src/events/types.js";
import { foldFlowEvents } from "../src/flow/index.js";
import { runProcess } from "../src/process/run.js";
import { LocalWorkflowRunner } from "../src/workflow/runner.js";

class RecordingAgentService implements RoleAgentService {
  readonly roles: string[] = [];

  async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
    this.roles.push(options.role);
    let value: unknown;
    if (options.role === "orchestrator" && options.promptKey !== "orchestrator-final") {
      value = { goalSummary: "Create a file", instructionsForArchitect: "One task", constraints: [], risk: "low" };
    } else if (options.role === "architect") {
      value = {
        summary: "One file",
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
    this.roles.push(options.role);
    const context = options.context as { task: { id: string } };
    const target = path.join(options.cwd!, "out", `${context.task.id}.txt`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${context.task.id}\n`);
    return { text: "implemented", profileName: "fake-worker", usedFallback: false };
  }
}

function recorder(): { events: RunEvent[]; sink: RunEventSink } {
  const events: RunEvent[] = [];
  const sink: RunEventSink = {
    append(event: PendingRunEvent) {
      const stored: RunEvent = { ...event, sequence: events.length + 1, traceId: "t", spanId: "s" };
      events.push(stored);
      return stored;
    },
  };
  return { events, sink };
}

async function fixture(
  name: string,
  configure?: (config: ReturnType<typeof createDefaultConfig>) => void,
) {
  const root = await mkdtemp(path.join(tmpdir(), `agent-team-flow-${name}-`));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Agent Team Test"],
    ["config", "user.email", "agent-team@example.com"],
  ]) {
    await runProcess({ command: "git", args, cwd: root, timeoutMs: 30_000 });
  }
  const config = createDefaultConfig(name);
  config.quality.commands = [{ command: process.execPath, args: ["-e", "process.exit(0)"] }];
  configure?.(config);
  await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
  for (const args of [["add", "."], ["commit", "-m", "initial"]]) {
    await runProcess({ command: "git", args, cwd: root, timeoutMs: 30_000 });
  }
  return loadConfig(root);
}

describe("flow-driven workflow", () => {
  it("runs the quick template with one task and no model review or architect", async () => {
    const loaded = await fixture("quick");
    const agent = new RecordingAgentService();
    const { events, sink } = recorder();
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => agent,
      eventSink: sink,
    }).run({ goal: "Fix the typo in README", template: "quick" });

    expect(state.flow?.template).toBe("quick");
    expect(state.flow?.source).toBe("user");
    expect(state.tasks.map((task) => [task.task.id, task.status])).toEqual([["T1", "merged"]]);
    expect(state.tasks[0]?.review).toBeUndefined();
    expect(agent.roles).not.toContain("architect");
    expect(agent.roles).not.toContain("reviewer");
    expect(agent.roles).not.toContain("tester");
    expect(agent.roles).not.toContain("orchestrator");
    expect(state.status).toBe("awaiting-human");

    const progress = foldFlowEvents(events as RunEvent[]);
    expect(progress.selection?.template).toBe("quick");
    const done = progress.nodes.filter((node) => node.status === "completed").map((node) => node.nodeId);
    expect(done).toEqual(expect.arrayContaining(["plan", "execute", "final-checks", "decide"]));
  }, 30_000);

  it("never lets the quick template merge work that fails the deterministic gates", async () => {
    const loaded = await fixture("quick-fail", (config) => {
      config.quality.commands = [{ command: process.execPath, args: ["-e", "process.exit(1)"] }];
    });
    const agent = new RecordingAgentService();
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => agent,
    }).run({ goal: "Fix the typo in README", template: "quick" });

    expect(state.status).toBe("blocked");
    expect(state.tasks[0]?.status).toBe("blocked");
    expect(agent.roles).not.toContain("reviewer");
  }, 60_000);

  it("parks the full template at plan approval and records the parked node", async () => {
    const loaded = await fixture("full");
    const agent = new RecordingAgentService();
    const { events, sink } = recorder();
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => agent,
      eventSink: sink,
    }).run({ goal: "Create alpha", template: "full" });

    expect(state.status).toBe("awaiting-human");
    expect(state.tasks.every((task) => task.status === "pending")).toBe(true);
    const progress = foldFlowEvents(events as RunEvent[]);
    expect(progress.current).toBe("approve-plan");
    expect(progress.nodes.find((node) => node.nodeId === "approve-plan")?.status).toBe("parked");
  }, 30_000);

  it("routes automatically and records why", async () => {
    const loaded = await fixture("auto");
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new RecordingAgentService(),
    }).run({ goal: "Fix a typo in the README" });
    expect(state.flow?.source).toBe("router");
    expect(state.flow?.template).toBe("quick");
    expect(state.flow?.reasons.length).toBeGreaterThan(0);
  }, 30_000);

  it("keeps the v1 pipeline free of flow state and events when engine is v1", async () => {
    const loaded = await fixture("v1", (config) => {
      config.workflow = { engine: "v1", template: "auto", sessions: "auto" };
    });
    const { events, sink } = recorder();
    const state = await new LocalWorkflowRunner(loaded, {
      createAgentService: () => new RecordingAgentService(),
      eventSink: sink,
    }).run({ goal: "Fix a typo in the README" });
    expect(state.flow).toBeUndefined();
    expect(events.some((event) => event.type.startsWith("flow."))).toBe(false);
    expect(state.tasks.length).toBeGreaterThan(0);
  }, 30_000);
});
