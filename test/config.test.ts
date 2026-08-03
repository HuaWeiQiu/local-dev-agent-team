import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { findConfig, loadConfig } from "../src/config/load.js";

describe("configuration", () => {
  it("loads a valid config from a parent directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(root, "agent-team.yaml"),
      stringifyYaml(createDefaultConfig("fixture")),
    );

    expect(await findConfig(nested)).toBe(path.join(root, "agent-team.yaml"));
    const loaded = await loadConfig(nested);
    expect(loaded.config.project.name).toBe("fixture");
  });

  it("rejects a role that references an unknown profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.roles.worker.defaultProfile = "missing";
    config.roles.worker.allowedProfiles = ["missing"];
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow("unknown profile 'missing'");
  });
});
