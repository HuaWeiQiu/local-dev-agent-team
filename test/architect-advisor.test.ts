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
import type { ForkAdvisor, JevDecision, JevDecisionInput } from "../src/jev/policy.js";
import { runProcess } from "../src/process/run.js";
import { LocalWorkflowRunner } from "../src/workflow/runner.js";

type AdvisorRecommendation = "proceed" | "change_approach" | "stop";

interface AdvisorCall {
  trigger: string;
  context: Record<string, unknown>;
}

class AdvisorFixtureService implements RoleAgentService {
  readonly advisorCalls: AdvisorCall[] = [];
  readonly workerContexts: Array<Record<string, unknown>> = [];
  finalContexts: Array<Record<string, unknown>> = [];
  recommendation: AdvisorRecommendation = "change_approach";
  failAdvisor = false;

  constructor(private readonly taskIds: string[] = ["alpha"]) {}

  async runStructured<T>(options: RoleInvocationOptions<T>): Promise<RoleResponse<T>> {
    let value: unknown;
    const context = options.context as Record<string, unknown>;
    if (options.promptKey === "architect-advisor") {
      this.advisorCalls.push({ trigger: String(context.trigger), context });
      if (this.failAdvisor) {
        throw new Error("advisor profile chain exhausted");
      }
      value = {
        recommendation: this.recommendation,
        summary: "Check the failing command output first",
        advice: "Fix the root cause instead of retrying the same edit",
        risks: ["Edge case not covered"],
      };
    } else if (options.role === "orchestrator" && options.promptKey === "orchestrator-final") {
      this.finalContexts.push(context);
      value = { decision: "ready", reason: "All gates passed" };
    } else if (options.role === "orchestrator") {
      value = {
        goalSummary: "Create files",
        instructionsForArchitect: "Split the files",
        constraints: [],
        risk: "low",
      };
    } else if (options.role === "architect") {
      value = {
        summary: "Independent files",
        tasks: this.taskIds.map((id) => ({
          id,
          title: id,
          description: `Create ${id}.txt`,
          dependsOn: [],
          ownedPaths: [`${id}.txt`],
          acceptanceCommands: [],
          profile: null,
        })),
      };
    } else if (options.role === "reviewer") {
      value = { verdict: "approve", summary: "Looks correct", findings: [] };
    } else {
      value = { verdict: "approve", summary: "Covered", missingTests: [] };
    }
    return {
      value: options.schema.parse(value),
      profileName: "fake",
      usedFallback: false,
      text: JSON.stringify(value),
    };
  }

  async runText(options: TextRoleInvocationOptions): Promise<TextRoleResponse> {
    const context = options.context as { task: { id: string; ownedPaths: string[] } } & Record<
      string,
      unknown
    >;
    this.workerContexts.push(context);
    const target = path.join(options.cwd!, context.task.ownedPaths[0]!);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${context.task.id}\n`);
    return { text: "implemented", profileName: "fake-worker", usedFallback: false };
  }
}

const failingCommand = {
  command: process.execPath,
  args: ["-e", "console.error('boom: assertion failed'); process.exit(1)"],
};

async function createFixture(options: {
  qualityPasses: boolean;
  advisor: {
    enabled: boolean;
    triggers: Array<"repeated-failure" | "pre-final">;
    maxConsultationsPerRun: number;
  };
}): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-advisor-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Agent Team Test"]);
  await git(root, ["config", "user.email", "agent-team@example.com"]);
  const config = createDefaultConfig("advisor");
  config.quality.commands = [
    options.qualityPasses
      ? { command: process.execPath, args: ["-e", "process.exit(0)"] }
      : failingCommand,
  ];
  config.strategies!.definitions.advised = {
    maxParallel: 2,
    maxReworkAttempts: 2,
    roleProfiles: {},
    approvalGates: ["final"],
    taskMorphology: { advisor: options.advisor },
  };
  await writeFile(path.join(root, ".gitignore"), ".agent-team/\n");
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return await loadConfig(root);
}

async function runWith(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  service: AdvisorFixtureService,
  forkAdvisor?: ForkAdvisor,
) {
  const events: PendingRunEvent[] = [];
  const eventSink: RunEventSink = {
    append(event) {
      events.push(event);
      return { ...event, sequence: events.length, traceId: "trace", spanId: "span" };
    },
  };
  const state = await new LocalWorkflowRunner(loaded, {
    createAgentService: () => service,
    eventSink,
    ...(forkAdvisor ? { forkAdvisor } : {}),
  }).run({ goal: "Create the files", strategyName: "advised" });
  return { state, events };
}

const bothTriggers = ["repeated-failure", "pre-final"] as const;

describe("architect advisor", () => {
  it("consults the architect when the same failure repeats and injects the advice", async () => {
    const loaded = await createFixture({
      qualityPasses: false,
      advisor: { enabled: true, triggers: [...bothTriggers], maxConsultationsPerRun: 3 },
    });
    const service = new AdvisorFixtureService();
    const { state, events } = await runWith(loaded, service);

    expect(service.advisorCalls.map((call) => call.trigger)).toEqual(["repeated-failure"]);
    expect(service.workerContexts).toHaveLength(3);
    expect(service.workerContexts[0]).not.toHaveProperty("architectAdvice");
    expect(service.workerContexts[1]).not.toHaveProperty("architectAdvice");
    expect(service.workerContexts[2]).toMatchObject({
      architectAdvice: { recommendation: "change_approach" },
    });
    expect(state.advisorConsultations).toBe(1);
    expect(events.filter((event) => event.type === "run.advisor.consulted")).toHaveLength(1);
  }, 60_000);

  it("blocks the task without burning more attempts when the advisor says stop", async () => {
    const loaded = await createFixture({
      qualityPasses: false,
      advisor: { enabled: true, triggers: ["repeated-failure"], maxConsultationsPerRun: 3 },
    });
    const service = new AdvisorFixtureService();
    service.recommendation = "stop";
    const { state } = await runWith(loaded, service);

    expect(service.workerContexts).toHaveLength(2);
    expect(state.tasks[0]?.status).toBe("blocked");
    expect(state.tasks[0]?.error).toContain("Architect advisor stopped the task");
  }, 60_000);

  it("never consults the advisor when it is disabled", async () => {
    const loaded = await createFixture({
      qualityPasses: false,
      advisor: { enabled: false, triggers: [...bothTriggers], maxConsultationsPerRun: 3 },
    });
    const service = new AdvisorFixtureService();
    const { state } = await runWith(loaded, service);

    expect(service.advisorCalls).toEqual([]);
    expect(service.workerContexts).toHaveLength(3);
    expect(state.advisorConsultations).toBeUndefined();
  }, 60_000);

  it("fails open when the advisor invocation fails", async () => {
    const loaded = await createFixture({
      qualityPasses: false,
      advisor: { enabled: true, triggers: ["repeated-failure"], maxConsultationsPerRun: 3 },
    });
    const service = new AdvisorFixtureService();
    service.failAdvisor = true;
    const { events } = await runWith(loaded, service);

    expect(service.advisorCalls).toHaveLength(1);
    expect(service.workerContexts).toHaveLength(3);
    expect(service.workerContexts[2]).not.toHaveProperty("architectAdvice");
    expect(events.some((event) => event.type === "run.advisor.failed")).toBe(true);
  }, 60_000);

  it("respects the per-run consultation limit across parallel tasks", async () => {
    const loaded = await createFixture({
      qualityPasses: false,
      advisor: { enabled: true, triggers: ["repeated-failure"], maxConsultationsPerRun: 1 },
    });
    const service = new AdvisorFixtureService(["alpha", "beta"]);
    const { state, events } = await runWith(loaded, service);

    expect(service.advisorCalls).toHaveLength(1);
    expect(state.advisorConsultations).toBe(1);
    expect(events.filter((event) => event.type === "run.advisor.skipped")).toHaveLength(1);
  }, 60_000);

  it("reviews the integrated result before the final decision when quality passed", async () => {
    const loaded = await createFixture({
      qualityPasses: true,
      advisor: { enabled: true, triggers: ["pre-final"], maxConsultationsPerRun: 3 },
    });
    const service = new AdvisorFixtureService();
    const { state } = await runWith(loaded, service);

    expect(state.status).toBe("awaiting-human");
    expect(service.advisorCalls.map((call) => call.trigger)).toEqual(["pre-final"]);
    expect(service.finalContexts).toHaveLength(1);
    expect(service.finalContexts[0]).toMatchObject({
      preFinalAdvice: { risks: ["Edge case not covered"] },
    });
  }, 60_000);

  it("skips the pre-final consultation when that trigger is not enabled", async () => {
    const loaded = await createFixture({
      qualityPasses: true,
      advisor: { enabled: true, triggers: ["repeated-failure"], maxConsultationsPerRun: 3 },
    });
    const service = new AdvisorFixtureService();
    await runWith(loaded, service);

    expect(service.advisorCalls).toEqual([]);
    expect(service.finalContexts[0]).not.toHaveProperty("preFinalAdvice");
  }, 60_000);
});

class ScriptedFork implements ForkAdvisor {
  readonly inputs: JevDecisionInput[] = [];

  constructor(private readonly reply: JevDecision | undefined | "throw") {}

  async decide(input: JevDecisionInput): Promise<JevDecision | undefined> {
    this.inputs.push(input);
    if (this.reply === "throw") {
      throw new Error("jev down");
    }
    return this.reply;
  }
}

describe("jev fork layer", () => {
  const advised = { enabled: true, triggers: ["repeated-failure" as const], maxConsultationsPerRun: 3 };

  it("brings the architect forward on a confident consult decision", async () => {
    const loaded = await createFixture({ qualityPasses: false, advisor: advised });
    const service = new AdvisorFixtureService();
    const fork = new ScriptedFork({ decision: "consult", confidence: 0.95 });
    const { events } = await runWith(loaded, service, fork);

    expect(fork.inputs[0]).toMatchObject({ attempt: 2, repeated: false });
    expect(service.advisorCalls[0]?.context).toMatchObject({ repeated: false, escalatedBy: "jev" });
    expect(service.workerContexts[1]).toMatchObject({
      architectAdvice: { recommendation: "change_approach" },
    });
    expect(events.find((event) => event.type === "run.jev.decided")?.payload).toMatchObject({
      source: "jev",
      consult: true,
      changedOutcome: true,
    });
  }, 60_000);

  it("skips the architect on a confident retry decision", async () => {
    const loaded = await createFixture({ qualityPasses: false, advisor: advised });
    const service = new AdvisorFixtureService();
    const fork = new ScriptedFork({ decision: "retry", confidence: 0.9 });
    const { state, events } = await runWith(loaded, service, fork);

    expect(service.advisorCalls).toEqual([]);
    expect(service.workerContexts).toHaveLength(3);
    expect(state.advisorConsultations).toBeUndefined();
    const decided = events.filter((event) => event.type === "run.jev.decided");
    expect(decided.at(-1)?.payload).toMatchObject({ repeated: true, changedOutcome: true });
  }, 60_000);

  it("falls back to the deterministic rule on low confidence, errors, or no answer", async () => {
    for (const reply of [
      { decision: "retry", confidence: 0.4 } satisfies JevDecision,
      undefined,
      "throw" as const,
    ]) {
      const loaded = await createFixture({ qualityPasses: false, advisor: advised });
      const service = new AdvisorFixtureService();
      const { events } = await runWith(loaded, service, new ScriptedFork(reply));

      expect(service.advisorCalls.map((call) => call.trigger)).toEqual(["repeated-failure"]);
      expect(service.advisorCalls[0]?.context).toMatchObject({ repeated: true });
      expect(
        events
          .filter((event) => event.type === "run.jev.decided")
          .every((event) => (event.payload as { source: string }).source === "deterministic"),
      ).toBe(true);
    }
  }, 120_000);

  it("is not consulted when the architect advisor is disabled", async () => {
    const loaded = await createFixture({
      qualityPasses: false,
      advisor: { ...advised, enabled: false },
    });
    const service = new AdvisorFixtureService();
    const fork = new ScriptedFork({ decision: "consult", confidence: 1 });
    await runWith(loaded, service, fork);

    expect(fork.inputs).toEqual([]);
    expect(service.advisorCalls).toEqual([]);
  }, 60_000);
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
}
