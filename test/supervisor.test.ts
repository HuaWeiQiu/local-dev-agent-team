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
    expect(await supervisor.cancel(first.runId)).toBe(true);
    await expect(completed).resolves.toMatchObject({ status: "cancelled" });
    expect(await supervisor.cancel(first.runId)).toBe(false);
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
    await supervisor.cancel(retry.runId);
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
    const foreign = fakeState("foreign-active", "Run owned by a stopped service", "implementing");
    foreign.supervisorId = randomUUID();
    const proposer = fakeState("orphaned-proposer", "Generate candidate", "orchestrating");
    proposer.supervisorId = randomUUID();
    proposer.purpose = "evolution-proposer";
    await Promise.all([
      states.save(plan),
      states.save(final),
      states.save(expired),
      states.save(foreign),
      states.save(proposer),
    ]);
    const supervisor = new RunSupervisor(loaded, events);

    expect(await supervisor.reconcileInterruptedRuns()).toBe(5);
    await expect(supervisor.get(plan.id)).resolves.toMatchObject({ status: "interrupted" });
    await expect(supervisor.get(final.id)).resolves.toMatchObject({ status: "ready-to-merge" });
    await expect(supervisor.get(expired.id)).resolves.toMatchObject({
      status: "blocked",
      approvals: [{ status: "rejected", response: { actor: "system:approval-expiry" } }],
    });
    await expect(supervisor.get(foreign.id)).resolves.toMatchObject({
      status: "interrupted",
      error: "The owning control service stopped before the run completed",
    });
    await expect(supervisor.get(proposer.id)).resolves.toMatchObject({
      status: "cancelled",
      purpose: "evolution-proposer",
    });
    await expect(supervisor.retry(proposer.id)).rejects.toThrow("cannot be retried directly");
    await supervisor.close();
    events.close();
  });

  it("reconciles active runs with foreign or missing supervisor ownership", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const cliRun = fakeState("cli-run", "Started by agent-team run", "implementing");
    const foreignRun = fakeState("foreign-run", "Started by another service", "implementing");
    foreignRun.supervisorId = randomUUID();
    await Promise.all([states.save(cliRun), states.save(foreignRun)]);
    const supervisor = new RunSupervisor(loaded, events);

    // The startup lease guarantees no other live supervisor, so both the
    // foreign-owned run and the legacy run without a supervisorId are dead.
    expect(await supervisor.reconcileInterruptedRuns()).toBe(2);
    await expect(supervisor.get(cliRun.id)).resolves.toMatchObject({
      status: "interrupted",
      error: "The owning control service stopped before the run completed",
    });
    await expect(supervisor.get(foreignRun.id)).resolves.toMatchObject({
      status: "interrupted",
      error: "The owning control service stopped before the run completed",
    });
    await supervisor.close();
    events.close();
  });

  it("rejects evolution mutation while a run is active", async () => {
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
    const run = supervisor.start({ goal: "Hold active run", profileOverrides: {} });

    expect(() => supervisor.beginEvolutionMutation()).toThrow(
      "Project has an active run or run action",
    );

    expect(await supervisor.cancel(run.runId)).toBe(true);
    await expect(supervisor.wait(run.runId)).resolves.toMatchObject({ status: "cancelled" });
    const release = supervisor.beginEvolutionMutation();
    release();
    await supervisor.close();
    events.close();
  });

  it("rejects evolution mutation while a run action is queued", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = fakeApprovalState("queued-final-action", "final");
    await states.save(state);
    const supervisor = new RunSupervisor(loaded, events);

    const action = supervisor.respondApproval(state.id, {
      requestId: state.approvals![0]!.id,
      decision: "approved",
      actor: "release-owner",
      reason: "Approve while checking the mutation gate",
    });
    expect(() => supervisor.beginEvolutionMutation()).toThrow(
      "Project has an active run or run action",
    );
    await expect(action).resolves.toEqual({ runId: state.id, status: "ready-to-merge" });

    const release = supervisor.beginEvolutionMutation();
    release();
    await supervisor.close();
    events.close();
  });

  it("blocks new runs, approval continuations, and actions while mutation latch is held", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const plan = fakeApprovalState("blocked-plan-continuation", "plan");
    const retryable = fakeState("blocked-retry-action", "Retry after mutation", "interrupted");
    await Promise.all([states.save(plan), states.save(retryable)]);
    let starts = 0;
    let continuations = 0;
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        starts += 1;
        return fakeState(context.runId, request.goal, "completed");
      },
      resumeWorkflow: async (state) => {
        continuations += 1;
        return state;
      },
    });
    const release = supervisor.beginEvolutionMutation();

    expect(() =>
      supervisor.start({ goal: "Must wait for mutation", profileOverrides: {} }),
    ).toThrow("Project target mutation is in progress");
    await expect(
      supervisor.respondApproval(plan.id, {
        requestId: plan.approvals![0]!.id,
        decision: "approved",
        actor: "tech-lead",
        reason: "Continuation must remain blocked",
      }),
    ).rejects.toThrow("run actions are temporarily unavailable");
    await expect(supervisor.retry(retryable.id, "retry-during-mutation")).rejects.toThrow(
      "run actions are temporarily unavailable",
    );
    expect(starts).toBe(0);
    expect(continuations).toBe(0);
    await expect(supervisor.get(plan.id)).resolves.toMatchObject({
      status: "awaiting-human",
      approvals: [{ status: "pending" }],
    });

    release();
    await supervisor.close();
    events.close();
  });

  it("waits for a held mutation latch before closing", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const supervisor = new RunSupervisor(loaded, events);
    const release = supervisor.beginEvolutionMutation();
    const closing = supervisor.close();

    expect(
      await Promise.race([
        closing.then(() => "closed" as const),
        Promise.resolve("waiting" as const),
      ]),
    ).toBe("waiting");
    expect(() => supervisor.beginEvolutionMutation()).toThrow(
      "Evolution mutations are sealed while the control service is closing",
    );

    release();
    await expect(withTimeout(closing, 1_000)).resolves.toBeUndefined();
    events.close();
  });

  it("drains an already queued run action before closing its stores", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = fakeApprovalState("closing-queued-action", "final");
    await states.save(state);
    const supervisor = new RunSupervisor(loaded, events);
    const originalGet = supervisor.get.bind(supervisor);
    let signalGetStarted!: () => void;
    let releaseGet!: () => void;
    const getStarted = new Promise<void>((resolve) => {
      signalGetStarted = resolve;
    });
    const getReleased = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    supervisor.get = async (runId) => {
      signalGetStarted();
      await getReleased;
      return await originalGet(runId);
    };

    const action = supervisor.respondApproval(state.id, {
      requestId: state.approvals![0]!.id,
      decision: "approved",
      actor: "release-owner",
      reason: "This accepted action must finish before shutdown",
    });
    await getStarted;
    const closing = supervisor.close();
    expect(
      await Promise.race([
        closing.then(() => "closed" as const),
        Promise.resolve("waiting" as const),
      ]),
    ).toBe("waiting");

    releaseGet();
    await expect(action).resolves.toEqual({ runId: state.id, status: "ready-to-merge" });
    await expect(withTimeout(closing, 1_000)).resolves.toBeUndefined();
    events.close();
  });

  it("previews and removes only old terminal runs with a one-time token", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const completed = fakeState("old-completed", "Old completed run", "completed");
    const interrupted = fakeState("old-interrupted", "Recoverable run", "interrupted");
    const retryParent = fakeState("old-retry-parent", "Retried blocked run", "blocked");
    const retryChild = fakeState("recent-retry-child", "Retried blocked run", "completed");
    retryChild.parentRunId = retryParent.id;
    const oldTimestamp = new Date(Date.now() - 60 * 86_400_000).toISOString();
    await Promise.all([
      states.save(completed),
      states.save(interrupted),
      states.save(retryParent),
      states.save(retryChild),
    ]);
    completed.updatedAt = oldTimestamp;
    interrupted.updatedAt = oldTimestamp;
    retryParent.updatedAt = oldTimestamp;
    await Promise.all([
      writeFile(path.join(states.runDirectory(completed.id), "state.json"), `${JSON.stringify(completed)}\n`),
      writeFile(path.join(states.runDirectory(interrupted.id), "state.json"), `${JSON.stringify(interrupted)}\n`),
      writeFile(path.join(states.runDirectory(retryParent.id), "state.json"), `${JSON.stringify(retryParent)}\n`),
    ]);
    events.emit(completed.id, "run.fixture", { retained: false });
    events.emit(interrupted.id, "run.fixture", { retained: true });
    const supervisor = new RunSupervisor(loaded, events);

    const preview = await supervisor.previewCleanup(30);
    expect(preview.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: completed.id, status: "completed" }),
        expect.objectContaining({ id: interrupted.id, status: "interrupted" }),
      ]),
    );
    expect(preview.candidates).toHaveLength(2);
    await expect(supervisor.cleanup(preview.token)).resolves.toEqual({
      deletedRunIds: expect.arrayContaining([completed.id, interrupted.id]),
      reclaimedBytes: expect.any(Number),
    });
    await expect(supervisor.get(completed.id)).resolves.toBeUndefined();
    await expect(supervisor.get(interrupted.id)).resolves.toBeUndefined();
    await expect(supervisor.get(retryParent.id)).resolves.toMatchObject({ status: "blocked" });
    expect(events.listAfter(0, completed.id)).toEqual([]);
    expect(events.listAfter(0, interrupted.id)).toEqual([]);
    await expect(supervisor.cleanup(preview.token)).rejects.toThrow("missing or expired");

    // single-run delete for a blocked parent still protected by child until child is gone
    await expect(supervisor.deleteRun(retryParent.id)).rejects.toThrow(/parent/i);

    const stale = fakeState("stale-preview", "Changed after preview", "cancelled");
    await states.save(stale);
    stale.updatedAt = oldTimestamp;
    await writeFile(
      path.join(states.runDirectory(stale.id), "state.json"),
      `${JSON.stringify(stale)}\n`,
    );
    const stalePreview = await supervisor.previewCleanup(30);
    const changed = await states.load(stale.id);
    changed.error = "Operator added a note";
    await states.save(changed);
    await expect(supervisor.cleanup(stalePreview.token)).rejects.toThrow("changed after preview");
    await expect(supervisor.get(stale.id)).resolves.toMatchObject({
      status: "cancelled",
      error: "Operator added a note",
    });

    await supervisor.close();
    events.close();
  });

  it("gives a bounded automation session exclusive run and target ownership", async () => {
    const { root, loaded } = await fixtureConfig();
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    let finishRun!: () => void;
    const runFinished = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        await runFinished;
        return fakeState(context.runId, request.goal, "completed");
      },
    });
    const automation = supervisor.beginAutomationSession();

    expect(() => supervisor.start({ goal: "ordinary run", profileOverrides: {} }))
      .toThrow("Automatic evolution owns the project");
    expect(() => supervisor.beginEvolutionMutation())
      .toThrow("Automatic evolution owns the project");
    const releaseMutation = automation.beginTargetMutation();
    expect(() => automation.start({ goal: "overlap target write", profileOverrides: {} }))
      .toThrow("Project target mutation is in progress");
    releaseMutation();

    const evaluation = automation.start({ goal: "isolated evaluation", profileOverrides: {} });
    expect(() => automation.release()).toThrow("cannot release project ownership");
    await expect(supervisor.cancel(evaluation.runId)).rejects.toThrow(
      "Automatic evolution owns run cancellation",
    );
    finishRun();
    await expect(supervisor.wait(evaluation.runId)).resolves.toMatchObject({ status: "completed" });
    automation.release();

    const ordinary = supervisor.start({ goal: "ordinary run after release", profileOverrides: {} });
    await expect(supervisor.wait(ordinary.runId)).resolves.toMatchObject({ status: "completed" });
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

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for supervisor close")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
