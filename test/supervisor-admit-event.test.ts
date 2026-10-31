import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { RunSupervisor, goalFromTrigger } from "../src/server/supervisor.js";
import { loadConfig } from "../src/config/load.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { SqliteEventStore } from "../src/events/store.js";
import { makeTrigger } from "../src/intake/types.js";
import { TicketStore } from "../src/authority/ticket-store.js";
import type { RunState } from "../src/state/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-intake-"));
  roots.push(root);
  await writeFile(
    path.join(root, "agent-team.yaml"),
    stringify(createDefaultConfig("fixture")),
  );
  const loaded = await loadConfig(root);
  const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
  return { root, loaded, events };
}

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

async function supervisor() {
  const { root, loaded, events } = await fixture();
  const instance = new RunSupervisor(loaded, events, {
    runWorkflow: async (request, context) => fakeRunState(context.runId, request.goal),
  });
  return { instance, events, root, stateDir: loaded.config.project.stateDirectory };
}

function comment(body: string): Record<string, unknown> {
  return {
    repository: { full_name: "acme/demo" },
    issue: { number: 7, pull_request: { url: "x" } },
    comment: { id: 900, body, user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z" },
  };
}

describe("admitEvent", () => {
  it("starts a run for a comment that addresses the agent", async () => {
    const { instance, events, root, stateDir } = await supervisor();
    const result = await instance.admitEvent({
      event: "issue_comment",
      payload: comment("@agent-bot please fix the flaky test"),
      agentLogins: ["agent-bot"],
      instanceId: "acme/demo",
    });
    expect(result.admitted).toHaveLength(1);
    expect(result.refused).toEqual([]);
    const { ticketId, runId } = result.admitted[0]!;
    expect(runId).toBeTruthy();
    // The binding happens around the workflow, so let the run finish first.
    await instance.wait(runId).catch(() => undefined);
    // The Ticket is on disk, with the Assignment the run carries.
    const store = new TicketStore(TicketStore.pathFor(path.join(root, stateDir)));
    const ticket = await store.get(ticketId);
    expect(ticket?.assignments.map((entry) => entry.runId)).toEqual([runId]);
    await instance.close();
    events.close();
  });

  it("starts nothing for a comment that only mentions the thread", async () => {
    const { instance, events } = await supervisor();
    const result = await instance.admitEvent({
      event: "issue_comment",
      payload: comment("looks good to me"),
      agentLogins: ["agent-bot"],
      instanceId: "acme/demo",
    });
    expect(result.admitted).toEqual([]);
    expect(result.refused[0]!.code).toBe("proactive_disallowed");
    await instance.close();
    events.close();
  });

  it("starts nothing when the event is not listened to", async () => {
    const { instance, events } = await supervisor();
    const result = await instance.admitEvent({
      event: "push",
      payload: comment("@agent-bot go"),
      agentLogins: ["agent-bot"],
      instanceId: "acme/demo",
    });
    expect(result.admitted).toEqual([]);
    expect(result.dropped[0]!.code).toBe("not-listened");
    await instance.close();
    events.close();
  });

  it("keeps the second comment on the same thread on the same Ticket", async () => {
    const { instance, events } = await supervisor();
    const first = await instance.admitEvent({
      event: "issue_comment",
      payload: comment("@agent-bot first"),
      agentLogins: ["agent-bot"],
      instanceId: "acme/demo",
    });
    const second = await instance.admitEvent({
      event: "issue_comment",
      payload: {
        ...comment("@agent-bot second"),
        comment: { id: 901, body: "@agent-bot second", user: { login: "alice" }, created_at: "2026-01-01T00:00:01Z" },
      },
      agentLogins: ["agent-bot"],
      instanceId: "acme/demo",
    });
    expect(second.admitted[0]!.ticketId).toBe(first.admitted[0]!.ticketId);
    await instance.close();
    events.close();
  });
});

describe("goalFromTrigger", () => {
  it("carries the words and names the thread", () => {
    const trigger = makeTrigger({
      sourceKind: "github",
      sourceInstanceId: "acme/demo",
      externalId: "comment:1",
      kind: "comment",
      threads: [{ sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "pull/7" }],
      actor: { sourceKind: "github", id: "alice" },
      at: "2026-01-01T00:00:00.000Z",
      payload: { body: "fix the flaky test" },
    })!;
    const goal = goalFromTrigger(trigger);
    expect(goal).toContain("fix the flaky test");
    expect(goal).toContain("pull/7");
  });

  it("describes an event that carries no words", () => {
    const trigger = makeTrigger({
      sourceKind: "github",
      sourceInstanceId: "acme/demo",
      externalId: "check:1",
      kind: "ci-change",
      threads: [{ sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "pull/7" }],
      actor: { sourceKind: "github", id: "ci" },
      at: "2026-01-01T00:00:00.000Z",
    })!;
    expect(goalFromTrigger(trigger)).toContain("ci-change");
  });
});
