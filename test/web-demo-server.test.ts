// @vitest-environment jsdom
import "./web/dom-setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoServer, installDemoMode } from "../web/src/demo/server.js";

type Response = { status: number; body: any };

function server(): DemoServer {
  return new DemoServer();
}

function get(s: DemoServer, path: string, method = "GET", body: Record<string, unknown> = {}): Response {
  return s.handle(method, path, body) as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("demo server platform routes", () => {
  it("serves the workspace, config and desktop inventory", () => {
    const s = server();
    expect(get(s, "/api/workspace").status).toBe(200);
    expect(get(s, "/api/config").status).toBe(200);
    expect(get(s, "/api/desktop/settings").status).toBe(200);
    expect(get(s, "/api/desktop/cli-inventory/scan").status).toBe(200);
    expect(get(s, "/api/evolution").status).toBe(200);
    expect(get(s, "/api/jev/probe")).toMatchObject({ status: 200, body: { ok: false } });
    expect(get(s, "/api/onboarding").status).toBe(200);
    expect(get(s, "/api/onboarding/quality").status).toBe(200);
    expect(get(s, "/api/role-settings").body).toMatchObject({ projectId: "storefront" });
  });

  it("scopes the project from the path", () => {
    const s = server();
    const scoped = get(s, "/api/projects/docs-site/role-settings");
    expect(scoped.body).toMatchObject({ projectId: "docs-site" });
    expect(get(s, "/api/projects/docs-site/runs").body).toMatchObject({ runs: [] });
  });
});

describe("demo server run collection", () => {
  it("lists, creates and previews cleanup", () => {
    const s = server();
    const listed = get(s, "/api/runs");
    expect(listed.body.runs.length).toBeGreaterThan(0);

    const created = get(s, "/api/runs", "POST", { goal: "新目标", strategy: "balanced" });
    expect(typeof created.body.runId).toBe("string");

    const preview = get(s, "/api/runs/cleanup/preview", "GET", { olderThanDays: 3 });
    expect(preview.body).toMatchObject({ token: "demo-token", olderThanDays: 3 });
    expect(preview.body.totalBytes).toBe(preview.body.candidates.length * 120_000);

    expect(get(s, "/api/runs/cleanup").body).toMatchObject({ deletedRunIds: [] });
  });

  it("serves usage, experience and retrieval stubs", () => {
    const s = server();
    expect(get(s, "/api/usage").body.runCount).toBeGreaterThan(0);
    expect(get(s, "/api/experience").body.entries.length).toBeGreaterThan(0);
    expect(get(s, "/api/experience/retrieve").body).toMatchObject({ note: "演示数据" });
  });
});

describe("demo server run entities", () => {
  const runId = (s: DemoServer) => get(s, "/api/runs").body.runs[0].id as string;

  it("serves every detail endpoint", () => {
    const s = server();
    const id = runId(s);
    for (const rest of ["", "/evidence", "/evidence/file", "/export", "/agents", "/explain", "/usage", "/replay", "/transcripts"]) {
      const response = get(s, `/api/runs/${id}${rest}`);
      expect(response.status).toBe(200);
    }
    expect(get(s, `/api/runs/${id}/transcript?id=x`)).toMatchObject({ status: 200 });
    expect(get(s, `/api/runs/${id}/tasks/task-coupon/diff`).status).toBe(200);
  });

  it("404s for an unknown run and an unknown route", () => {
    const s = server();
    expect(get(s, "/api/runs/nope")).toMatchObject({ status: 404 });
    expect(get(s, "/api/nope")).toMatchObject({ status: 404 });
    const id = runId(s);
    expect(get(s, `/api/runs/${id}/nothing`)).toMatchObject({ status: 404 });
  });

  it("records agent interventions", () => {
    const s = server();
    const id = runId(s);
    for (const action of ["steer", "interrupt", "answer"]) {
      const response = get(s, `/api/runs/${id}/agents/a-1/${action}`, "POST", {
        text: "focus",
        note: "note",
        questionId: "q",
        answer: "yes",
      });
      expect(response.body).toMatchObject({ ok: true });
    }
  });

  it("runs every run action", () => {
    const s = server();
    const id = runId(s);
    const run = get(s, `/api/runs/${id}`).body.run;
    const requestId = run.approvals?.[0]?.id;

    expect(get(s, `/api/runs/${id}/actions/pause`, "POST").body).toEqual({});
    expect(get(s, `/api/runs/${id}/actions/cancel`, "POST").body).toEqual({});
    expect(get(s, `/api/runs/${id}/actions/resume`, "POST").body).toEqual({});

    const approved = get(s, `/api/runs/${id}/actions/respond-approval`, "POST", {
      requestId,
      decision: "approved",
      reason: "ok",
    });
    expect(approved.status).toBe(200);

    const published = get(s, `/api/runs/${id}/actions/publish`, "POST");
    expect(published.body).toMatchObject({ status: "completed" });
    expect(published.body.pullRequestUrl).toContain("/pull/200");

    const retried = get(s, `/api/runs/${id}/actions/retry`, "POST");
    expect(typeof retried.body.runId).toBe("string");

    const deleted = get(s, `/api/runs/${id}/actions/delete`, "POST");
    expect(deleted.body).toMatchObject({ deletedRunIds: [id] });

    expect(get(s, `/api/runs/${id}/actions/unknown`, "POST")).toMatchObject({ status: 404 });
  });

  it("rejects a rejected approval and an unknown run action", () => {
    const s = server();
    const id = runId(s);
    const run = get(s, `/api/runs/${id}`).body.run;
    const response = get(s, `/api/runs/${id}/actions/respond-approval`, "POST", {
      requestId: run.approvals?.[0]?.id,
      decision: "rejected",
    });
    expect(response.status).toBe(200);
    expect(get(s, "/api/runs/missing/actions/pause", "POST")).toMatchObject({ status: 404 });
  });
});

describe("live streaming", () => {
  it("streams stdout for the running demo run", () => {
    vi.useFakeTimers();
    const s = server();
    const seen: string[] = [];
    s.subscribe("storefront", undefined, (event) => seen.push(event.type));
    vi.advanceTimersByTime(2_000 * 20);
    expect(seen.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("creates a run with the default strategy and scripts its lifecycle", () => {
    vi.useFakeTimers();
    const s = server();
    const id = s.createRun("storefront", "演示目标", undefined);
    const created = get(s, `/api/runs/${id}`).body.run;
    expect(created.strategy.name).toBe("balanced");
    expect(created.goal).toBe("演示目标");
    expect(created.strategy.approvalGates).toEqual(["final"]);

    // An unknown strategy falls back to the default definition.
    const fallback = s.createRun("storefront", "另一个目标", "no-such-strategy");
    const other = get(s, `/api/runs/${fallback}`).body.run;
    expect(other.strategy.name).toBe("no-such-strategy");
    expect(other.strategy.maxParallel).toBeGreaterThan(0);
    vi.advanceTimersByTime(10_000);
    const later = get(s, `/api/runs/${id}`).body.run;
    expect(later.history.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});

describe("installDemoMode", () => {
  it("routes /api calls to the demo server and passes others through", async () => {
    const nativeFetch = vi.fn().mockResolvedValue({ ok: true });
    window.fetch = nativeFetch as never;
    installDemoMode();

    const scoped = await window.fetch("/api/workspace");
    expect((scoped as unknown as Response).status).toBe(200);

    await window.fetch("https://example.test/other");
    expect(nativeFetch).toHaveBeenCalled();
  });

  it("opens a demo EventSource for a run and replays its events", async () => {
    vi.useFakeTimers();
    installDemoMode();
    const s = new DemoServer();
    const runId = get(s, "/api/runs").body.runs[0].id as string;
    const Source = (window as unknown as { EventSource: new (url: string) => {
      readyState: number;
      onmessage: ((event: { data: string }) => void) | null;
      close(): void;
    } }).EventSource;
    const source = new Source(`/api/projects/storefront/events?runId=${runId}`);
    const received: string[] = [];
    source.onmessage = (event) => received.push(event.data);
    vi.advanceTimersByTime(100);
    expect(received.length).toBeGreaterThan(0);
    source.close();
    expect(source.readyState).toBe(2);
    vi.useRealTimers();
  });

  it("ignores a malformed request body", async () => {
    installDemoMode();
    const response = await window.fetch("/api/runs", { method: "POST", body: "{not json" });
    expect((response as Response).status).toBe(200);
  });
});
