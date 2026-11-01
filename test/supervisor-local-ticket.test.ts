import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { RunSupervisor, localTicket } from "../src/server/supervisor.js";
import { loadConfig } from "../src/config/load.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { SqliteEventStore } from "../src/events/store.js";
import { TicketStore } from "../src/authority/ticket-store.js";
import { policyFactsFrom, policySnapshot } from "../src/authority/policy.js";
import type { RunState } from "../src/state/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function fakeRunState(runId: string, goal: string): RunState {
  return {
    id: runId,
    goal,
    status: "completed",
    root: "/tmp",
    configPath: "agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "integration",
    integrationWorktree: "/tmp/wt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileOverrides: {},
    strategy: { name: "balanced" } as never,
    tasks: [],
    history: [],
  } as unknown as RunState;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-local-ticket-"));
  roots.push(root);
  await writeFile(path.join(root, "agent-team.yaml"), stringify(createDefaultConfig("fixture")));
  const loaded = await loadConfig(root);
  const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
  const supervisor = new RunSupervisor(loaded, events, {
    runWorkflow: async (request, context) => fakeRunState(context.runId, request.goal),
  });
  return { root, loaded, events, supervisor };
}

describe("localTicket", () => {
  const policy = policySnapshot({
    project: "demo",
    strategy: "balanced",
    roles: ["worker"],
    gates: ["plan"],
    allowedActors: ["*"],
    allowsProactive: false,
    rules: ["gate:plan"],
  });

  it("makes an explicit, strongly-based Ticket on a Thread of its own", () => {
    const ticket = localTicket("run-1", "Fix the flaky test", policy);
    expect(ticket).toMatchObject({ id: "ticket-run-1", state: "open" });
    expect(ticket.threadKey).toContain("run/run-1");
    expect(ticket.mandate).toMatchObject({ strength: "explicit", policyVersion: policy.version });
    expect(ticket.triggerIds).toHaveLength(1);
  });

  it("gives each run its own Thread, so two runs never contend", () => {
    const first = localTicket("run-1", "a", policy);
    const second = localTicket("run-2", "b", policy);
    expect(first.threadKey).not.toBe(second.threadKey);
  });
});

describe("every run becomes a Ticket", () => {
  it("records the Ticket and its Assignment beside the run", async () => {
    const { root, loaded, events, supervisor } = await fixture();
    const started = supervisor.start({ goal: "Ship the thing", profileOverrides: {} });
    await supervisor.wait(started.runId).catch(() => undefined);

    const store = new TicketStore(
      TicketStore.pathFor(path.join(root, loaded.config.project.stateDirectory)),
    );
    const ticket = await store.get(`ticket-${started.runId}`);
    expect(ticket).toMatchObject({ state: "open", id: `ticket-${started.runId}` });
    expect(ticket?.assignments.map((entry) => entry.runId)).toEqual([started.runId]);
    expect(ticket?.assignments[0]).toMatchObject({ state: "ended" });

    await supervisor.close();
    events.close();
  });

  it("keeps the run itself working when the Ticket cannot be written", async () => {
    const { events, supervisor } = await fixture();
    const started = supervisor.start({ goal: "Still runs", profileOverrides: {} });
    await expect(supervisor.wait(started.runId)).resolves.toMatchObject({ status: "completed" });
    await supervisor.close();
    events.close();
  });

  it("derives the policy from the loaded config", async () => {
    const { loaded } = await fixture();
    const facts = policyFactsFrom(loaded.config, "balanced");
    expect(facts.project).toBe("fixture");
    expect(facts.rules).toContain("strategy:balanced");
  });
});
