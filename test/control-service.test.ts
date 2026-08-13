import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import { listenControlServer } from "../src/server/http.js";
import { startControlService } from "../src/server/start.js";
import { RunSupervisor } from "../src/server/supervisor.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

describe("control service lifecycle", () => {
  it("holds one project lease and releases it on close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-control-"));
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("fixture")),
    );
    const loaded = await loadConfig(root);
    const first = await startControlService(loaded, { port: 0 });
    await expect(startControlService(loaded, { port: 0 })).rejects.toThrow(
      "Another control service is already running",
    );
    await first.close();

    const second = await startControlService(loaded, { port: 0 });
    await second.close();
  });

  it("refuses non-loopback binding and releases the lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-control-"));
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("fixture")),
    );
    const loaded = await loadConfig(root);
    await expect(
      startControlService(loaded, { host: "0.0.0.0", port: 0 }),
    ).rejects.toThrow("must bind to a loopback host");
    const recovered = await startControlService(loaded, { port: 0 });
    await recovered.close();
  });
});

describe("run action HTTP semantics", () => {
  it("maps run action failures to distinct HTTP statuses", async () => {
    const { supervisor, events, listening } = await startHttpFixture();

    const unknownStrategy = await fetch(`${listening.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Bad strategy", strategy: "nope" }),
    });
    expect(unknownStrategy.status).toBe(400);
    await expect(unknownStrategy.json()).resolves.toMatchObject({
      code: "INVALID_REQUEST",
    });

    const badKey = await fetch(`${listening.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "bad key!" },
      body: JSON.stringify({ goal: "Bad key" }),
    });
    expect(badKey.status).toBe(400);
    await expect(badKey.json()).resolves.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });

    const badRetryKey = await fetch(`${listening.url}/api/runs/some-run/actions/retry`, {
      method: "POST",
      headers: { "idempotency-key": "x".repeat(200) },
    });
    expect(badRetryKey.status).toBe(400);
    await expect(badRetryKey.json()).resolves.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });

    // The header stays optional.
    const start = await fetch(`${listening.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "No key needed" }),
    });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };

    const resumeMissing = await fetch(`${listening.url}/api/runs/missing-run/actions/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "operator", reason: "recover" }),
    });
    expect(resumeMissing.status).toBe(404);
    await expect(resumeMissing.json()).resolves.toMatchObject({ code: "RUN_NOT_FOUND" });

    const retryMissing = await fetch(`${listening.url}/api/runs/missing-run/actions/retry`, {
      method: "POST",
    });
    expect(retryMissing.status).toBe(404);

    const resumeActive = await fetch(
      `${listening.url}/api/runs/${encodeURIComponent(runId)}/actions/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "operator", reason: "recover" }),
      },
    );
    expect(resumeActive.status).toBe(409);
    await expect(resumeActive.json()).resolves.toMatchObject({ code: "RUN_STATE_CONFLICT" });

    const cancel = await fetch(
      `${listening.url}/api/runs/${encodeURIComponent(runId)}/actions/cancel`,
      { method: "POST" },
    );
    expect(cancel.status).toBe(202);
    await supervisor.wait(runId);

    await supervisor.close();
    await listening.close();
    events.close();
  });

  it("cancels awaiting-human and interrupted runs that are not active", async () => {
    const { root, supervisor, events, listening } = await startHttpFixture();
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    await states.save(fakeRunState("parked-run", "Parked at a gate", "awaiting-human"));
    await states.save(fakeRunState("interrupted-run", "Stopped service", "interrupted"));

    const cancelParked = await fetch(`${listening.url}/api/runs/parked-run/actions/cancel`, {
      method: "POST",
    });
    expect(cancelParked.status).toBe(202);
    await expect(supervisor.get("parked-run")).resolves.toMatchObject({
      status: "cancelled",
      error: "Run cancelled by user",
    });

    const cancelInterrupted = await fetch(
      `${listening.url}/api/runs/interrupted-run/actions/cancel`,
      { method: "POST" },
    );
    expect(cancelInterrupted.status).toBe(202);
    await expect(supervisor.get("interrupted-run")).resolves.toMatchObject({
      status: "cancelled",
    });

    // Terminal runs and unknown runs still conflict.
    const cancelAgain = await fetch(`${listening.url}/api/runs/parked-run/actions/cancel`, {
      method: "POST",
    });
    expect(cancelAgain.status).toBe(409);
    const cancelUnknown = await fetch(`${listening.url}/api/runs/ghost-run/actions/cancel`, {
      method: "POST",
    });
    expect(cancelUnknown.status).toBe(409);

    await supervisor.close();
    await listening.close();
    events.close();
  });
});

describe("run supervisor resilience", () => {
  it("releases the idempotency claim when a run dies before its first persist", async () => {
    const { loaded, events } = await supervisorFixture();
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async () => {
        throw new Error("disk exploded");
      },
    });

    const first = supervisor.start({ goal: "Doomed run", profileOverrides: {} }, "doomed-key");
    await expect(supervisor.wait(first.runId)).rejects.toThrow("disk exploded");

    const retry = supervisor.start({ goal: "Doomed run", profileOverrides: {} }, "doomed-key");
    expect(retry.deduplicated).toBe(false);
    expect(retry.runId).not.toBe(first.runId);
    await expect(supervisor.wait(retry.runId)).rejects.toThrow("disk exploded");
    await supervisor.close();
    events.close();
  });

  it("keeps the idempotency claim when the crashed run persisted state", async () => {
    const { root, loaded, events } = await supervisorFixture();
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        await states.save(fakeRunState(context.runId, request.goal, "blocked"));
        throw new Error("crashed after persist");
      },
    });

    const first = supervisor.start(
      { goal: "Persisted crash", profileOverrides: {} },
      "crash-key",
    );
    await expect(supervisor.wait(first.runId)).rejects.toThrow("crashed after persist");

    const retry = supervisor.start(
      { goal: "Persisted crash", profileOverrides: {} },
      "crash-key",
    );
    expect(retry).toEqual({ runId: first.runId, deduplicated: true });
    await supervisor.close();
    events.close();
  });

  it("marks legacy active runs without a supervisorId interrupted on startup", async () => {
    const { root, loaded, events } = await supervisorFixture();
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    await states.save(fakeRunState("legacy-active", "Left by an old version", "implementing"));
    const supervisor = new RunSupervisor(loaded, events);

    expect(await supervisor.reconcileInterruptedRuns()).toBe(1);
    await expect(supervisor.get("legacy-active")).resolves.toMatchObject({
      status: "interrupted",
      error: "The owning control service stopped before the run completed",
    });
    await supervisor.close();
    events.close();
  });
});

async function supervisorFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-control-"));
  await writeFile(
    path.join(root, "agent-team.yaml"),
    stringifyYaml(createDefaultConfig("fixture")),
  );
  const loaded = await loadConfig(root);
  const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
  return { root, loaded, events };
}

async function startHttpFixture() {
  const { root, loaded, events } = await supervisorFixture();
  const supervisor = new RunSupervisor(loaded, events, {
    runWorkflow: async (request, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return fakeRunState(context.runId, request.goal, "cancelled");
    },
  });
  const listening = await listenControlServer(loaded, supervisor, {
    host: "127.0.0.1",
    port: 0,
  });
  return { root, loaded, events, supervisor, listening };
}

function fakeRunState(runId: string, goal: string, status: RunState["status"]): RunState {
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
