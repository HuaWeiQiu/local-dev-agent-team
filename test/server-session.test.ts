import { createHash } from "node:crypto";
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

describe("desktop control session", () => {
  it("exchanges a bootstrap token for an API session cookie", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-session-"));
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("desktop-fixture")),
    );
    const staticDirectory = path.join(root, "web");
    await mkdir(staticDirectory);
    await writeFile(path.join(staticDirectory, "index.html"), "<main>Agent Team</main>");
    const loaded = await loadConfig(root);
    const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
    const supervisor = new RunSupervisor(loaded, events);
    const token = "d".repeat(64);
    const listening = await listenControlServer(loaded, supervisor, {
      host: "127.0.0.1",
      port: 0,
      staticDirectory,
      sessionToken: token,
    });

    try {
      expect((await fetch(listening.url)).status).toBe(200);
      expect((await fetch(`${listening.url}/api/health`)).status).toBe(401);
      expect(
        (await fetch(`${listening.url}/__agent_team/session?token=wrong`)).status,
      ).toBe(401);

      const bootstrap = await fetch(
        `${listening.url}/__agent_team/session?token=${token}`,
        { redirect: "manual" },
      );
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.get("location")).toBe("/?desktop-runtime=1");
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
      const cookieSuffix = createHash("sha256").update(token).digest("hex").slice(0, 16);
      expect(cookie).toBe(`agent_team_session_${cookieSuffix}=${token}`);

      const health = await fetch(`${listening.url}/api/health`, {
        headers: { cookie: cookie! },
      });
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        status: "ok",
        project: "desktop-fixture",
      });

      expect((await fetch(`${listening.url}/api/role-settings`)).status).toBe(401);
      const roleSettings = await fetch(`${listening.url}/api/role-settings`, {
        headers: { cookie: cookie! },
      });
      expect(roleSettings.status).toBe(200);
      await expect(roleSettings.json()).resolves.toMatchObject({
        projectName: "desktop-fixture",
        roles: {},
      });
    } finally {
      await listening.close();
      await supervisor.close();
      events.close();
    }
  });

  it.each(["short", "D".repeat(64), "g".repeat(64)])(
    "rejects an invalid desktop session token: %s",
    async (sessionToken) => {
      const root = await mkdtemp(path.join(tmpdir(), "agent-team-session-"));
      await writeFile(
        path.join(root, "agent-team.yaml"),
        stringifyYaml(createDefaultConfig("desktop-fixture")),
      );
      const loaded = await loadConfig(root);
      const events = new SqliteEventStore(path.join(root, ".agent-team", "events.sqlite"));
      const supervisor = new RunSupervisor(loaded, events);
      await expect(
        listenControlServer(loaded, supervisor, {
          host: "127.0.0.1",
          port: 0,
          sessionToken,
        }),
      ).rejects.toThrow("64 lowercase hexadecimal characters");
      await supervisor.close();
      events.close();
    },
  );
});
