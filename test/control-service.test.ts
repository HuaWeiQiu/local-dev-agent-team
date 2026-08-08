import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import { startControlService } from "../src/server/start.js";

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
