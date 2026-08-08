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
    expect(loaded.config.observability.maxEventsPerRun).toBe(50_000);
  });

  it("rejects a role that references an unknown profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.roles.worker.defaultProfile = "missing";
    config.roles.worker.allowedProfiles = ["missing"];
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow("unknown profile 'missing'");
  });

  it("rejects unknown adapters and unsupported adapter capabilities during validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.profiles["codex-planner"]!.adapter = "unknown";
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await expect(loadConfig(root)).rejects.toThrow("Unknown agent adapter 'unknown'");

    config.profiles["codex-planner"]!.adapter = "codex";
    config.profiles["codex-planner"]!.reasoning = "max";
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));
    await expect(loadConfig(root)).rejects.toThrow(
      "Adapter 'codex' does not support reasoning 'max'",
    );
  });

  it("rejects a strategy profile outside the role allowlist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.balanced!.roleProfiles = {
      reviewer: "codex-worker",
    };
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow(
      "Profile 'codex-worker' is not allowed for role 'reviewer'",
    );
  });

  it("rejects write-enabled profiles for every non-worker role path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.roles.tester!.allowedProfiles.push("codex-worker");
    config.roles.tester!.fallbackProfiles.push("codex-worker");
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow(
      "tester cannot allow workspace-write profile 'codex-worker'",
    );
  });

  it("rejects inherited MCP tools on a read-only profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.profiles["codex-planner"]!.externalTools = "inherit";
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow(
      "Read-only profiles cannot inherit external MCP tools",
    );
  });

  it("rejects a Codex native profile when user configuration is isolated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.profiles["codex-planner"]!.nativeProfile = "personal";
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow(
      "Codex nativeProfile requires externalTools: inherit",
    );
  });

  it("rejects native profiles on non-Codex adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.profiles["codex-planner"]!.adapter = "claude";
    config.profiles["codex-planner"]!.nativeProfile = "personal";
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow(
      "nativeProfile is supported only by the Codex adapter",
    );
  });

  it("rejects a strategy that removes final human approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.balanced!.approvalGates = ["plan"];
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow(
      "Every strategy must include the final approval gate",
    );
  });

  it("rejects contradictory sequential concurrency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.strategies!.definitions.balanced!.topology = { mode: "sequential" };
    config.strategies!.definitions.balanced!.maxParallel = 2;
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow(
      "Sequential strategies require maxParallel to be 1",
    );
  });

  it("rejects observability and budget limits outside bounded ranges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-config-"));
    const config = createDefaultConfig("fixture");
    config.observability.maxEventsPerRun = 99;
    config.strategies!.definitions.balanced!.maxAgentInvocations = 0;
    await writeFile(path.join(root, "agent-team.yaml"), stringifyYaml(config));

    await expect(loadConfig(root)).rejects.toThrow("Too small");
  });
});
