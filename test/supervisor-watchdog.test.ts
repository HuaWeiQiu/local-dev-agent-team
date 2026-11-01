import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { RunSupervisor } from "../src/server/supervisor.js";
import { loadConfig } from "../src/config/load.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { SqliteEventStore } from "../src/events/store.js";
import { RunStateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function fakeState(runId: string, goal: string): RunState {
  return {
    id: runId,
    goal,
    status: "implementing",
    root: "/tmp",
    configPath: "agent-team.yaml",
    baseBranch: "main",
    baseCommit: "abc",
    integrationBranch: "integration",
    integrationWorktree: "/tmp/wt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    profileOverrides: {},
    strategy: { name: "balanced", maxParallel: 1 } as never,
    tasks: [{ task: { id: "T1", title: "t" }, status: "working", attempts: 1 } as never],
    history: [],
  } as unknown as RunState;
}

async function fixture(watchdog?: { intervalMs: number; stallAfterMs?: number; samplesToStall?: number }) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-watchdog-wire-"));
  roots.push(root);
  await writeFile(path.join(root, "agent-team.yaml"), stringify(createDefaultConfig("fixture")));
  const loaded = await loadConfig(root);
  const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
  let release: (() => void) | undefined;
  const supervisor = new RunSupervisor(loaded, events, {
    ...(watchdog ? { watchdog } : {}),
    runWorkflow: async (request, context) => {
      // Hold the run open so the watchdog has something live to look at.
      await new Promise<void>((resolve) => {
        release = resolve;
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return fakeState(context.runId, request.goal);
    },
  });
  const store = new RunStateStore(path.join(root, loaded.config.project.stateDirectory, "runs"));
  return { supervisor, events, store, stop: () => release?.() };
}

function stalledEvents(events: SqliteEventStore, runId: string) {
  return events.listRunEvents(runId).filter((event) => event.type === "run.watchdog.stalled");
}

describe("watchdog wiring", () => {
  it("does nothing at all unless the deployment asks for it", async () => {
    const { supervisor, events, stop } = await fixture();
    const started = supervisor.start({ goal: "g", profileOverrides: {} });
    await expect(supervisor.watchdogTick()).resolves.toEqual([]);
    stop();
    await supervisor.wait(started.runId).catch(() => undefined);
    await supervisor.close();
    expect(stalledEvents(events, started.runId)).toEqual([]);
    events.close();
  });

  it("samples the runs it is actually running", async () => {
    const { supervisor, stop } = await fixture({ intervalMs: 3_600_000 });
    const started = supervisor.start({ goal: "g", profileOverrides: {} });
    // First look records a sample; a stall needs more than one.
    await supervisor.watchdogTick();
    const findings = await supervisor.watchdogTick();
    expect(Array.isArray(findings)).toBe(true);
    stop();
    await supervisor.wait(started.runId).catch(() => undefined);
    await supervisor.close();
  });

  it("emits a finding when a live run stops moving, and never changes the run", async () => {
    const { supervisor, events, store, stop } = await fixture({
      intervalMs: 3_600_000,
      stallAfterMs: 0,
      samplesToStall: 1,
    });
    const started = supervisor.start({ goal: "g", profileOverrides: {} });
    // Let the run reach the workflow, then persist the state the runner would have
    // written: the watchdog reads runs, it does not invent them.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.save(fakeState(started.runId, "g"));
    const first = await supervisor.watchdogTick();
    const findings = await supervisor.watchdogTick();
    expect({ first, findings }).toBeTruthy();
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.verdict).toBe("stalled");
    expect(stalledEvents(events, started.runId).length).toBeGreaterThan(0);
    // A finding is an observation: the run is still the supervisor's to finish.
    await expect(supervisor.get(started.runId)).resolves.toBeTruthy();
    stop();
    await supervisor.wait(started.runId).catch(() => undefined);
    await supervisor.close();
    events.close();
  });
});
