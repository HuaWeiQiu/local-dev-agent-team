import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import type { RunState } from "../src/state/types.js";
import { RunSupervisor } from "../src/server/supervisor.js";
import { RunStateStore } from "../src/state/store.js";

describe("run supervisor", () => {
  it("deduplicates starts and cancels the managed run", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    let starts = 0;
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        starts += 1;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return fakeState(context.runId, request.goal, "cancelled");
      },
    });

    const first = supervisor.start(
      { goal: "Implement API", profileOverrides: {} },
      "same-request",
    );
    const second = supervisor.start(
      { goal: "Implement API", profileOverrides: {} },
      "same-request",
    );
    expect(second).toEqual({ runId: first.runId, deduplicated: true });
    expect(starts).toBe(1);

    const completed = supervisor.wait(first.runId);
    expect(supervisor.cancel(first.runId)).toBe(true);
    await expect(completed).resolves.toMatchObject({ status: "cancelled" });
    expect(supervisor.cancel(first.runId)).toBe(false);
    await supervisor.close();
    events.close();
  });

  it("rejects reusing an idempotency key for different input", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return fakeState(context.runId, request.goal, "cancelled");
      },
    });
    supervisor.start({ goal: "First", profileOverrides: {} }, "request-key");
    expect(() =>
      supervisor.start({ goal: "Second", profileOverrides: {} }, "request-key"),
    ).toThrow("already used for another request");
    await supervisor.close();
    events.close();
  });

  it("retries an interrupted run as a linked new run", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const runsDirectory = path.join(root, ".agent-team", "runs");
    const states = new RunStateStore(runsDirectory, events);
    const source = fakeState("source-run", "Resume safely", "interrupted");
    await states.save(source);
    let retriedParent: string | undefined;
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        retriedParent = request.parentRunId;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return fakeState(context.runId, request.goal, "cancelled");
      },
    });

    const retry = await supervisor.retry(source.id, "retry-source");
    expect(retry.runId).not.toBe(source.id);
    expect(retriedParent).toBe(source.id);
    supervisor.cancel(retry.runId);
    await supervisor.close();
    events.close();
  });

  it("records final approval idempotently and rejects conflicting responses", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = fakeApprovalState("final-run", "final");
    await states.save(state);
    const supervisor = new RunSupervisor(loaded, events);
    const response = {
      requestId: state.approvals![0]!.id,
      decision: "approved" as const,
      actor: "release-owner",
      reason: "Reviewed integration diff",
    };

    await expect(supervisor.respondApproval(state.id, response)).resolves.toEqual({
      runId: state.id,
      status: "ready-to-merge",
    });
    await expect(supervisor.respondApproval(state.id, response)).resolves.toEqual({
      runId: state.id,
      status: "unchanged",
    });
    await expect(
      supervisor.respondApproval(state.id, { ...response, reason: "Changed reason" }),
    ).rejects.toThrow("already has a response");
    await expect(supervisor.get(state.id)).resolves.toMatchObject({
      status: "ready-to-merge",
      approvals: [{ status: "approved", response: { actor: "release-owner" } }],
    });
    await supervisor.close();
    events.close();
  });

  it("continues an approved plan through the managed active-run lifecycle", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = fakeApprovalState("plan-run", "plan");
    await states.save(state);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let resumeMode: string | undefined;
    const supervisor = new RunSupervisor(loaded, events, {
      resumeWorkflow: async (resumed, options) => {
        resumeMode = options.mode;
        await finished;
        return resumed;
      },
    });

    const action = await supervisor.respondApproval(state.id, {
      requestId: state.approvals![0]!.id,
      decision: "approved",
      actor: "tech-lead",
      reason: "Task ownership is valid",
    });
    expect(action.status).toBe("resuming");
    expect(resumeMode).toBe("approval");
    const completion = supervisor.wait(state.id);
    finish();
    await expect(completion).resolves.toBeDefined();
    await supervisor.close();
    events.close();
  });

  it("marks an approved plan interrupted when continuation cannot start", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = fakeApprovalState("plan-start-failure", "plan");
    await states.save(state);
    const supervisor = new RunSupervisor(loaded, events, {
      resumeWorkflow: () => {
        throw new Error("resume dependency unavailable");
      },
    });

    await expect(
      supervisor.respondApproval(state.id, {
        requestId: state.approvals![0]!.id,
        decision: "approved",
        actor: "tech-lead",
        reason: "Plan reviewed",
      }),
    ).rejects.toThrow("resume dependency unavailable");
    await expect(supervisor.get(state.id)).resolves.toMatchObject({
      status: "interrupted",
      error: "resume dependency unavailable",
      approvals: [{ status: "approved" }],
    });
    await supervisor.close();
    events.close();
  });

  it("reconciles recorded approval responses and expired requests after restart", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const plan = fakeApprovalState("recorded-plan", "plan");
    plan.approvals![0]!.status = "approved";
    plan.approvals![0]!.response = {
      decision: "approved",
      actor: "lead",
      reason: "approved before restart",
      respondedAt: new Date().toISOString(),
    };
    const final = fakeApprovalState("recorded-final", "final");
    final.approvals![0]!.status = "approved";
    final.approvals![0]!.response = {
      decision: "approved",
      actor: "owner",
      reason: "approved before restart",
      respondedAt: new Date().toISOString(),
    };
    const expired = fakeApprovalState("expired-request", "final");
    expired.approvals![0]!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    const unmanaged = fakeState("legacy-active", "Recover legacy run", "implementing");
    await Promise.all([
      states.save(plan),
      states.save(final),
      states.save(expired),
      states.save(unmanaged),
    ]);
    const supervisor = new RunSupervisor(loaded, events);

    expect(await supervisor.reconcileInterruptedRuns()).toBe(4);
    await expect(supervisor.get(plan.id)).resolves.toMatchObject({ status: "interrupted" });
    await expect(supervisor.get(final.id)).resolves.toMatchObject({ status: "ready-to-merge" });
    await expect(supervisor.get(expired.id)).resolves.toMatchObject({
      status: "blocked",
      approvals: [{ status: "rejected", response: { actor: "system:approval-expiry" } }],
    });
    await expect(supervisor.get(unmanaged.id)).resolves.toMatchObject({
      status: "interrupted",
      error: "The owning control service stopped before the run completed",
    });
    await supervisor.close();
    events.close();
  });
});

async function fixtureConfig() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-supervisor-"));
  await writeFile(
    path.join(root, "agent-team.yaml"),
    stringifyYaml(createDefaultConfig("fixture")),
  );
  return { root, loaded: await loadConfig(root) };
}

function fakeState(runId: string, goal: string, status: RunState["status"]): RunState {
  const now = new Date().toISOString();
  return {
    id: runId,
    goal,
    root: "/tmp",
    configPath: "/tmp/agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: `agent-team/${runId}/integration`,
    integrationWorktree: `/tmp/${runId}`,
    status,
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
  };
}

function fakeApprovalState(runId: string, gate: "plan" | "final"): RunState {
  const state = fakeState(runId, "Review checkpoint", "awaiting-human");
  const checkpointId = randomUUID();
  state.checkpoints = [
    {
      id: checkpointId,
      version: 1,
      stage: gate === "plan" ? "plan-ready" : "local-gates-passed",
      integrationCommit: "abc",
      completedTaskIds: [],
      createdAt: new Date().toISOString(),
    },
  ];
  state.approvals = [
    {
      id: randomUUID(),
      gate,
      status: "pending",
      summary: "Review checkpoint",
      checkpointId,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
  return state;
}
