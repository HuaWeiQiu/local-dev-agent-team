import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import { buildPublicConfig, listenControlServer } from "../src/server/http.js";
import { RunSupervisor } from "../src/server/supervisor.js";
import type { RunState } from "../src/state/types.js";
import { RunStateStore } from "../src/state/store.js";
import { StrategyBlueprintCatalog } from "../src/strategies/catalog.js";

describe("control HTTP server", () => {
  it("projects a usable legacy strategy for configs without named strategies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-server-"));
    const config = createDefaultConfig("legacy-fixture");
    delete config.strategies;
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    const projected = buildPublicConfig(await loadConfig(root)) as {
      strategies: { default: string; definitions: Record<string, unknown> };
    };

    expect(projected.strategies.default).toBe("legacy");
    expect(projected.strategies.definitions).toHaveProperty("legacy");
    expect(projected.strategies.definitions.legacy).toMatchObject({
      compiledTopology: { version: 1, mode: "parallel-dag" },
    });
  });

  it("starts and cancels a run and exposes replayable events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-server-"));
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("fixture")),
    );
    const loaded = await loadConfig(root);
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return fakeState(context.runId, request.goal);
      },
    });
    const staticDirectory = path.join(root, "web");
    await mkdir(path.join(staticDirectory, "assets"), { recursive: true });
    await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
    await writeFile(path.join(staticDirectory, "assets", "app.js"), "console.log('ui')");
    const listening = await listenControlServer(loaded, supervisor, {
      host: "127.0.0.1",
      port: 0,
      staticDirectory,
    });

    const health = await fetch(`${listening.url}/api/health`).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as { project: string },
    }));
    expect(health).toEqual({ status: 200, body: expect.objectContaining({ project: "fixture" }) });

    const interop = await fetch(`${listening.url}/api/interop`);
    expect(interop.status).toBe(200);
    await expect(interop.json()).resolves.toMatchObject({
      schemaVersion: 1,
      adapters: [
        expect.objectContaining({ name: "claude", contractVersion: 1 }),
        expect.objectContaining({ name: "codex", contractVersion: 1 }),
      ],
      protocols: {
        mcp: { specification: "2026-07-28", defaultPolicy: "deny" },
        a2a: { specification: "1.0", mode: "disabled" },
      },
    });

    const web = await fetch(listening.url);
    expect(web.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await web.text()).toBe("<main>Agent Team</main>");
    expect(await fetch(`${listening.url}/runs/example`).then((response) => response.text())).toBe(
      "<main>Agent Team</main>",
    );
    expect(await fetch(`${listening.url}/assets/app.js`).then((response) => response.text())).toBe(
      "console.log('ui')",
    );
    expect((await fetch(`${listening.url}/%2e%2e/package.json`)).status).toBe(404);
    expect((await fetch(`${listening.url}/api`)).status).toBe(404);

    const start = await fetch(`${listening.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "web-1" },
      body: JSON.stringify({ goal: "Build dashboard", strategy: "balanced" }),
    });
    expect(start.status).toBe(202);
    const { runId } = (await start.json()) as { runId: string };

    const eventResponse = await fetch(
      `${listening.url}/api/events?runId=${encodeURIComponent(runId)}&after=0`,
    );
    const reader = eventResponse.body!.getReader();
    const eventText = await readUntil(reader, "run.queued");
    expect(eventText).toContain("run.queued");
    await reader.cancel();

    const cancel = await fetch(
      `${listening.url}/api/runs/${encodeURIComponent(runId)}/actions/cancel`,
      { method: "POST" },
    );
    expect(cancel.status).toBe(202);
    await supervisor.wait(runId);

    const forbidden = await fetch(`${listening.url}/api/health`, {
      headers: { origin: "https://example.com" },
    });
    expect(forbidden.status).toBe(403);

    await supervisor.close();
    await listening.close();
    events.close();
  });

  it("routes durable final approval responses through the supervisor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-server-"));
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("approval-fixture")),
    );
    const loaded = await loadConfig(root);
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = fakeState("approval-run", "Approve release");
    state.status = "awaiting-human";
    const checkpointId = randomUUID();
    const requestId = randomUUID();
    state.checkpoints = [{
      id: checkpointId,
      version: 1,
      stage: "local-gates-passed",
      integrationCommit: "abc",
      completedTaskIds: [],
      createdAt: new Date().toISOString(),
    }];
    state.approvals = [{
      id: requestId,
      gate: "final",
      status: "pending",
      summary: "Approve release",
      checkpointId,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }];
    await states.save(state);
    const reviewArtifacts = states.artifactDirectory(state.id, "tasks", "contract", "attempt-1", "review");
    await mkdir(reviewArtifacts, { recursive: true });
    await writeFile(path.join(reviewArtifacts, "last-message.json"), "{\"verdict\":\"approve\"}\n");
    const supervisor = new RunSupervisor(loaded, events);
    const staticDirectory = path.join(root, "web");
    await mkdir(staticDirectory, { recursive: true });
    await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
    const listening = await listenControlServer(loaded, supervisor, {
      host: "127.0.0.1",
      port: 0,
      staticDirectory,
    });

    const response = await fetch(
      `${listening.url}/api/runs/${state.id}/actions/respond-approval`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          decision: "approved",
          actor: "release-owner",
          reason: "Reviewed the local evidence",
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ready-to-merge" });
    await expect(supervisor.get(state.id)).resolves.toMatchObject({ status: "ready-to-merge" });
    const telemetry = await fetch(`${listening.url}/api/runs/${state.id}/telemetry`);
    expect(telemetry.status).toBe(200);
    await expect(telemetry.json()).resolves.toMatchObject({
      resourceSpans: [{ scopeSpans: [{ spans: expect.arrayContaining([
        expect.objectContaining({
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
          spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        }),
      ]) }] }],
    });
    const evidence = await fetch(`${listening.url}/api/runs/${state.id}/evidence`);
    expect(evidence.status).toBe(200);
    await expect(evidence.json()).resolves.toMatchObject({
      evidence: {
        runId: state.id,
        artifacts: [expect.objectContaining({
          path: "tasks/contract/attempt-1/review/last-message.json",
          kind: "review",
        })],
      },
    });
    const artifact = await fetch(
      `${listening.url}/api/runs/${state.id}/evidence/file?path=${encodeURIComponent("tasks/contract/attempt-1/review/last-message.json")}`,
    );
    await expect(artifact.json()).resolves.toMatchObject({
      file: { content: "{\"verdict\":\"approve\"}\n", truncated: false },
    });
    expect((await fetch(
      `${listening.url}/api/runs/${encodeURIComponent(`../${state.id}`)}/evidence`,
    )).status).toBe(404);
    const cleanupPreview = await fetch(`${listening.url}/api/runs/cleanup/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ olderThanDays: 30 }),
    });
    const cleanup = await cleanupPreview.json() as { token: string; candidates: unknown[] };
    expect(cleanup.candidates).toEqual([]);
    const cleanupResult = await fetch(`${listening.url}/api/runs/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: cleanup.token }),
    });
    await expect(cleanupResult.json()).resolves.toEqual({ deletedRunIds: [], reclaimedBytes: 0 });

    await listening.close();
    await supervisor.close();
    events.close();
  });

  it("preflights, persists, runs, and deletes custom strategy blueprints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-server-"));
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("blueprint-fixture")),
    );
    const catalog = await StrategyBlueprintCatalog.open(await loadConfig(root));
    const loaded = catalog.loaded;
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    let requestedStrategy: string | undefined;
    const supervisor = new RunSupervisor(loaded, events, {
      runWorkflow: async (request, context) => {
        requestedStrategy = request.strategy;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return fakeState(context.runId, request.goal);
      },
    });
    const staticDirectory = path.join(root, "web");
    await mkdir(staticDirectory, { recursive: true });
    await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
    const listening = await listenControlServer(loaded, supervisor, {
      host: "127.0.0.1",
      port: 0,
      staticDirectory,
      strategyCatalog: catalog,
    });
    const definition = {
      topology: { mode: "sequential" },
      maxParallel: 1,
      maxReworkAttempts: 3,
      maxAgentInvocations: 32,
      roleProfiles: {},
      approvalGates: ["plan", "final"],
    };

    const preflight = await fetch(`${listening.url}/api/strategies/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ui-strict", definition }),
    });
    expect(preflight.status).toBe(200);
    await expect(preflight.json()).resolves.toMatchObject({
      name: "ui-strict",
      resolved: { maxParallel: 1, topology: { mode: "sequential" } },
    });

    const save = await fetch(`${listening.url}/api/strategies/ui-strict`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition }),
    });
    expect(save.status).toBe(200);
    const publicConfig = await fetch(`${listening.url}/api/config`).then(
      async (response) => await response.json() as {
        strategies: { definitions: Record<string, { source: string }> };
      },
    );
    expect(publicConfig.strategies.definitions["ui-strict"]?.source).toBe("custom");

    const start = await fetch(`${listening.url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "custom-run" },
      body: JSON.stringify({ goal: "Run custom policy", strategy: "ui-strict" }),
    });
    expect(start.status).toBe(202);
    const { runId } = await start.json() as { runId: string };
    expect(requestedStrategy).toBe("ui-strict");
    supervisor.cancel(runId);
    await supervisor.wait(runId);

    const overwrite = await fetch(`${listening.url}/api/strategies/balanced`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition }),
    });
    expect(overwrite.status).toBe(409);
    const remove = await fetch(`${listening.url}/api/strategies/ui-strict`, { method: "DELETE" });
    expect(remove.status).toBe(200);
    expect(catalog.customNames()).toEqual([]);

    await listening.close();
    await supervisor.close();
    events.close();
  });

  it("exports run events as NDJSON and aggregates usage across runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-server-"));
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("usage-fixture")),
    );
    const loaded = await loadConfig(root);
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const states = new RunStateStore(path.join(root, ".agent-team", "runs"), events);
    const state = fakeState("export-run", "Export run events");
    state.usage = {
      agentInvocations: 3,
      agentDurationMs: 5_000,
      processOutputBytes: 100,
      truncatedStreams: 0,
      artifactBytes: 200,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reportedCostUsd: 0.125,
    };
    await states.save(state);
    events.emit("export-run", "agent.stdout", { role: "worker", chunk: "exported line\n" });
    await states.save(fakeState("bare-run", "No telemetry"));
    const supervisor = new RunSupervisor(loaded, events);
    const staticDirectory = path.join(root, "web");
    await mkdir(staticDirectory, { recursive: true });
    await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
    const listening = await listenControlServer(loaded, supervisor, {
      host: "127.0.0.1",
      port: 0,
      staticDirectory,
    });

    const exportResponse = await fetch(`${listening.url}/api/runs/export-run/export`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(exportResponse.headers.get("content-disposition")).toBe(
      'attachment; filename="export-run.ndjson"',
    );
    const exported = await exportResponse.text();
    const lines = exported.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(JSON.parse(line) as { runId: string }).toMatchObject({ runId: "export-run" });
    }
    expect(exported).toContain("agent.stdout");
    expect(exported).toContain("exported line");

    expect((await fetch(`${listening.url}/api/runs/missing-run/export`)).status).toBe(404);

    const usage = await fetch(`${listening.url}/api/usage`);
    expect(usage.status).toBe(200);
    const report = (await usage.json()) as {
      runCount: number;
      totals: Record<string, unknown>;
      runs: Array<{ runId: string; usage: Record<string, unknown> }>;
    };
    expect(report.runCount).toBe(2);
    expect(report.totals).toMatchObject({
      agentInvocations: 3,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reportedCostUsd: 0.125,
      costReported: true,
    });
    const byId = new Map(report.runs.map((entry) => [entry.runId, entry.usage]));
    expect(byId.get("export-run")).toMatchObject({
      agentInvocations: 3,
      reportedCostUsd: 0.125,
      costReported: true,
    });
    expect(byId.get("bare-run")).toMatchObject({
      agentInvocations: 0,
      reportedCostUsd: 0,
      costReported: false,
    });

    await listening.close();
    await supervisor.close();
    events.close();
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let contents = "";
  for (let reads = 0; reads < 10; reads += 1) {
    const result = await reader.read();
    contents += decoder.decode(result.value, { stream: !result.done });
    if (contents.includes(expected) || result.done) {
      return contents;
    }
  }
  return contents;
}

function fakeState(runId: string, goal: string): RunState {
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
    status: "cancelled",
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
