import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { SqliteEventStore } from "../src/events/store.js";
import { listenControlServer } from "../src/server/http.js";
import { RunSupervisor } from "../src/server/supervisor.js";

describe("SSE replay", () => {
  it("replays a long ledger in batches without losing or duplicating live events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-sse-"));
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(createDefaultConfig("sse")));
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

    try {
      const total = 2_500;
      for (let index = 0; index < total; index += 1) {
        events.emit("run-big", "run.updated", { index });
      }

      const response = await fetch(`${listening.url}/api/events?runId=run-big&after=0`);
      const live = events.emit("run-big", "run.live", { marker: true });
      events.emit("run-other", "run.updated", { ignored: true });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const ids: number[] = [];
      let pending = "";
      while (!ids.includes(live.sequence)) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        for (const match of pending.matchAll(/^id: (\d+)$/gm)) {
          ids.push(Number(match[1]));
        }
        pending = pending.slice(pending.lastIndexOf("\n\n") + 2);
      }
      await reader.cancel();

      expect(ids).toHaveLength(total + 1);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort((left, right) => left - right)).toEqual(ids);
      expect(ids.at(-1)).toBe(live.sequence);
    } finally {
      await supervisor.close();
      await listening.close();
      events.close();
    }
  }, 30_000);
});
