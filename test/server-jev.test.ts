import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import { listenControlServer } from "../src/server/http.js";
import { RunSupervisor } from "../src/server/supervisor.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function fakeJev(reply: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ url: request.url, ...body });
      const result = reply(body);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, requests };
}

async function startControl(jev?: { port: number }) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-team-jev-"));
  const config = createDefaultConfig("jev-fixture");
  const document = jev
    ? {
        ...config,
        jev: { enabled: false, baseUrl: `http://127.0.0.1:${jev.port}/v1`, model: "jev-test" },
      }
    : config;
  await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(document));
  const loaded = await loadConfig(root);
  const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
  const supervisor = new RunSupervisor(loaded, events, {
    runWorkflow: async () => {
      throw new Error("not used");
    },
  });
  const staticDirectory = path.join(root, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
  const listening = await listenControlServer(loaded, supervisor, {
    host: "127.0.0.1",
    port: 0,
    staticDirectory,
  });
  closers.push(async () => {
    await listening.close();
  });
  return listening.url;
}

describe("jev settings API", () => {
  it("exposes the jev config and probes the local model", async () => {
    const jev = await fakeJev(() => ({
      status: 200,
      body: {
        choices: [
          { message: { content: '{"decision":"consult","confidence":0.88,"reason":"loop"}' } },
        ],
      },
    }));
    const url = await startControl(jev);

    const config = (await (await fetch(`${url}/api/config`)).json()) as {
      jev?: { enabled: boolean; model: string; minConfidence: number };
    };
    expect(config.jev).toMatchObject({ enabled: false, model: "jev-test", minConfidence: 0.8 });

    const probe = await fetch(`${url}/api/jev/probe`, { method: "POST", body: "{}" });
    expect(probe.status).toBe(200);
    await expect(probe.json()).resolves.toMatchObject({
      ok: true,
      decision: { decision: "consult", confidence: 0.88 },
    });
    expect(jev.requests[0]).toMatchObject({ url: "/v1/chat/completions", model: "jev-test" });
  });

  it("reports why the probe failed instead of throwing", async () => {
    const jev = await fakeJev(() => ({ status: 503, body: {} }));
    const url = await startControl(jev);

    const probe = await fetch(`${url}/api/jev/probe`, { method: "POST", body: "{}" });
    expect(probe.status).toBe(200);
    await expect(probe.json()).resolves.toMatchObject({ ok: false, error: "HTTP 503" });
  });

  it("returns 404 when the project has no jev section", async () => {
    const url = await startControl();

    const config = (await (await fetch(`${url}/api/config`)).json()) as Record<string, unknown>;
    expect(config).not.toHaveProperty("jev");
    const probe = await fetch(`${url}/api/jev/probe`, { method: "POST", body: "{}" });
    expect(probe.status).toBe(404);
  });
});
