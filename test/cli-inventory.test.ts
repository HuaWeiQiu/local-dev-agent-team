import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inventorySourceFingerprint,
  scanCliInventory,
  type CliInventoryExecution,
} from "../src/desktop/cli-inventory.js";
import type { ProcessRequest, ProcessResult } from "../src/process/run.js";

/**
 * Answer "which CLIs are installed" from a script instead of from the machine.
 * The probe logic still runs for real — only the process boundary is answered —
 * so coverage no longer depends on what the developer or the runner happens to
 * have on PATH.
 */
function scriptedExecution(script: Record<string, { stdout?: string; exitCode?: number }>): {
  execution: CliInventoryExecution;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    execution: {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        const key = [path.basename(request.command), ...request.args].join(" ");
        calls.push(key);
        const hit = script[key] ?? { exitCode: 1, stdout: "" };
        return {
          command: request.command,
          args: request.args,
          exitCode: hit.exitCode ?? 0,
          stdout: hit.stdout ?? "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          signal: null,
        };
      },
    },
  };
}
import {
  materializeRoleBindings,
  parseRuntimeProfileName,
  roleBindingsFromRunState,
} from "../src/profiles/role-bindings.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import {
  getInventory,
  loadDesktopSettings,
  sanitizeRoleBindings,
  saveDesktopSettings,
  suggestDefaultsFromInventory,
} from "../src/desktop/settings.js";

describe("cli inventory and role bindings", () => {
  it("scans fixture home directories without leaking secrets", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-inv-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n[model_providers.sub2api]\nbase_url = "https://example.test"\nwire_api = "responses"\n`,
      "utf8",
    );
    await writeFile(path.join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"sk-secret-should-not-leak"}\n`, "utf8");
    await mkdir(path.join(home, ".grok"), { recursive: true });
    await writeFile(
      path.join(home, ".grok", "config.toml"),
      `[models]\ndefault = "grok-4.6"\n[model."grok-4.6"]\nmodel = "grok-4.6"\napi_key = "xai-secret"\n`,
      "utf8",
    );

    const { execution } = scriptedExecution({
      "which codex": { stdout: "/usr/local/bin/codex\n" },
      "codex --version": { stdout: "codex-cli 0.147.0\n" },
      "which grok": { stdout: "/usr/local/bin/grok\n" },
      "grok --version": { stdout: "grok 4.6.0\n" },
    });
    const inventory = await scanCliInventory(home, execution);
    const json = JSON.stringify(inventory);
    expect(json).not.toContain("sk-secret");
    expect(json).not.toContain("xai-secret");

    const codex = inventory.clis.find((cli) => cli.id === "codex");
    expect(codex?.installed).toBe(true);
    expect(codex?.version).toBe("codex-cli 0.147.0");
    expect(codex?.auth.status).toBe("present");
    expect(codex?.defaultModel).toBe("gpt-5.6-sol");
    expect(codex?.providers?.some((p) => p.id === "sub2api")).toBe(true);

    const grok = inventory.clis.find((cli) => cli.id === "grok");
    expect(grok?.auth.status).toBe("present");
    expect(grok?.auth.detail).toMatch(/api_key/);
    expect(grok?.defaultModel).toBe("grok-4.6");
  });

  it("reads every probe's config and version from a fixed home and a scripted machine", async () => {
    // The four probes are separate functions with separate config formats. This case
    // walks the installed branch of all of them against one fixed home, so their
    // coverage is a property of the tests, not of who ran them.
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-inv-all-"));
    await mkdir(path.join(home, ".kimi-code"), { recursive: true });
    await writeFile(
      path.join(home, ".kimi-code", "config.toml"),
      `default_model = "kimi-k2"\n[api]\nkey = "kimi-secret"\n`,
      "utf8",
    );
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-sonnet-4", apiKey: "claude-secret" }),
      "utf8",
    );
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), `model = "gpt-5.6-sol"\n`, "utf8");
    await mkdir(path.join(home, ".grok"), { recursive: true });
    await writeFile(path.join(home, ".grok", "config.toml"), `[models]\ndefault = "grok-4.6"\n`, "utf8");

    const { execution } = scriptedExecution({
      "which codex": { stdout: "/usr/local/bin/codex\n" },
      "codex --version": { stdout: "codex-cli 0.147.0\n" },
      "which grok": { stdout: "/usr/local/bin/grok\n" },
      "grok --version": { stdout: "grok 4.6.0\n" },
      "which kimi": { stdout: "/usr/local/bin/kimi\n" },
      "kimi --version": { stdout: "kimi 0.9.1\n" },
      "which claude": { stdout: "/usr/local/bin/claude\n" },
      "claude --version": { stdout: "claude 4.2.0\n" },
    });
    const inventory = await scanCliInventory(home, execution);
    const byId = new Map(inventory.clis.map((cli) => [cli.id, cli]));

    for (const id of ["codex", "grok", "kimi", "claude"]) {
      expect(byId.get(id)?.installed, id).toBe(true);
      expect(byId.get(id)?.version, id).toBeTruthy();
      expect(byId.get(id)?.configPaths.length, id).toBeGreaterThan(0);
    }
    // Secrets on disk never reach the inventory payload.
    const json = JSON.stringify(inventory);
    expect(json).not.toContain("kimi-secret");
    expect(json).not.toContain("claude-secret");
  });

  it("reports a machine with nothing installed without consulting PATH", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-inv-empty-"));
    const { execution, calls } = scriptedExecution({});
    const inventory = await scanCliInventory(home, execution);

    expect(inventory.clis.every((cli) => cli.installed === false)).toBe(true);
    expect(inventory.clis.every((cli) => cli.version === undefined)).toBe(true);
    // The probes asked, and the answers came from the script, not the machine.
    expect(calls.every((call) => call.startsWith("which "))).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("materializes roleBindings into ephemeral profiles", () => {
    const config = createDefaultConfig("fixture");
    const material = materializeRoleBindings(config, {
      orchestrator: { cli: "grok", model: "grok", reasoning: "high" },
      worker: { cli: "codex", model: "gpt-5.6-sol", reasoning: "max" },
    });
    expect(material.profileOverrides.orchestrator).toMatch(/^runtime\/orchestrator\/grok\//);
    expect(material.profileOverrides.worker).toMatch(/^runtime\/worker\/codex\//);
    const orch = material.config.profiles[material.profileOverrides.orchestrator!];
    expect(orch?.adapter).toBe("grok");
    expect(orch?.permission).toBe("read-only");
    const worker = material.config.profiles[material.profileOverrides.worker!];
    expect(worker?.adapter).toBe("codex");
    expect(worker?.permission).toBe("workspace-write");
    expect(worker?.reasoning).toBe("max");
  });

  it("recovers picker bindings from persisted runtime profile names", () => {
    expect(parseRuntimeProfileName("runtime/worker/grok/grok-4.6/high")).toEqual({
      role: "worker",
      cli: "grok",
      model: "grok-4.6",
      reasoning: "high",
    });
    expect(roleBindingsFromRunState({
      profileOverrides: {
        worker: "runtime/worker/grok/grok-4.6/high",
        reviewer: "codex-reviewer",
      },
    })).toEqual({
      worker: { cli: "grok", model: "grok-4.6", reasoning: "high" },
    });
  });

  it("materializes kimi roleBindings onto the kimi adapter", () => {
    const config = createDefaultConfig("fixture");
    const material = materializeRoleBindings(config, {
      orchestrator: { cli: "kimi", model: "kimi-code", reasoning: "high" },
    });
    const profile = material.config.profiles[material.profileOverrides.orchestrator!];
    expect(profile?.adapter).toBe("kimi");
    expect(profile?.model).toBe("kimi-code");
    expect(profile?.permission).toBe("read-only");
  });

  it("suggests defaults preferring installed runtime-supported clis", () => {
    const defaults = suggestDefaultsFromInventory({
      scannedAt: new Date().toISOString(),
      home: "/tmp",
      clis: [
        {
          id: "kimi",
          installed: true,
          auth: { status: "present" },
          configPaths: [],
          models: [{ id: "kimi-code", label: "kimi" }],
          runtimeSupported: true,
        },
        {
          id: "grok",
          installed: true,
          auth: { status: "present" },
          configPaths: [],
          models: [{ id: "grok", label: "grok" }],
          defaultModel: "grok",
          defaultReasoning: "high",
          runtimeSupported: true,
        },
      ],
    });
    // codex not present; first preferred for orchestrator among codex/grok/claude is grok
    expect(defaults.orchestrator?.cli).toBe("grok");
    expect(defaults.worker?.cli).toBe("grok");
    expect(defaults.researcher?.cli).toBe("grok");
  });

  it("invalidates inventory cache when watched config mtime/content changes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-inv-fp-"));
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const configPath = path.join(home, ".codex", "config.toml");
    await writeFile(
      configPath,
      `model = "gpt-old"\nmodel_reasoning_effort = "medium"\n`,
      "utf8",
    );

    const { execution } = scriptedExecution({
      "which codex": { stdout: "/usr/local/bin/codex\n" },
      "codex --version": { stdout: "codex-cli 0.147.0\n" },
    });
    const first = await getInventory({ home, maxAgeMs: 60 * 60 * 1000, execution });
    expect(first.fromCache).toBe(false);
    expect(first.reason).toBe("miss");
    expect(first.inventory.sourceFingerprint).toBeTruthy();
    expect(first.inventory.clis.find((cli) => cli.id === "codex")?.defaultModel).toBe("gpt-old");

    const second = await getInventory({ home, maxAgeMs: 60 * 60 * 1000, execution });
    expect(second.fromCache).toBe(true);
    expect(second.reason).toBe("hit");
    expect(second.inventory.sourceFingerprint).toBe(first.inventory.sourceFingerprint);

    // Ensure mtime actually moves forward on some filesystems.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      configPath,
      `model = "gpt-new"\nmodel_reasoning_effort = "high"\n`,
      "utf8",
    );
    const afterFp = await inventorySourceFingerprint(home);
    expect(afterFp).not.toBe(first.inventory.sourceFingerprint);

    const third = await getInventory({ home, maxAgeMs: 60 * 60 * 1000, execution });
    expect(third.fromCache).toBe(false);
    expect(third.reason).toBe("fingerprint");
    expect(third.inventory.clis.find((cli) => cli.id === "codex")?.defaultModel).toBe("gpt-new");
    expect(third.inventory.clis.find((cli) => cli.id === "codex")?.defaultReasoning).toBe("high");
  });

  it("reports a stale cache from a home it prepared itself", async () => {
    // `"stale"` used to be reachable only when an earlier file happened to leave an
    // inventory cache on disk: the branch is "cache present, fingerprint unchanged,
    // age expired". Building that state here makes the branch a property of this test.
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-inv-stale-"));
    const { execution } = scriptedExecution({
      "which codex": { stdout: "/usr/local/bin/codex\n" },
      "codex --version": { stdout: "codex-cli 0.147.0\n" },
    });

    const first = await getInventory({ home, execution, maxAgeMs: 60 * 60 * 1000 });
    expect(first.reason).toBe("miss");

    const settings = await loadDesktopSettings(home);
    await saveDesktopSettings(
      { ...settings, inventoryCachedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      home,
    );
    const stale = await getInventory({ home, execution, maxAgeMs: 60_000 });
    expect(stale.fromCache).toBe(false);
    expect(stale.reason).toBe("stale");
  });

  it("sanitizes role bindings when model disappears from inventory", () => {
    const result = sanitizeRoleBindings(
      {
        worker: { cli: "codex", model: "gone-model", reasoning: "max" },
      },
      {
        scannedAt: new Date().toISOString(),
        home: "/tmp",
        clis: [
          {
            id: "codex",
            installed: true,
            auth: { status: "present" },
            configPaths: [],
            models: [{ id: "gpt-5.6-sol", label: "gpt-5.6-sol", reasoningOptions: ["low", "medium", "high"] }],
            defaultModel: "gpt-5.6-sol",
            defaultReasoning: "high",
            runtimeSupported: true,
          },
        ],
      },
    );
    expect(result.changed).toBe(true);
    expect(result.roles.worker?.model).toBe("gpt-5.6-sol");
    expect(result.roles.worker?.reasoning).toBe("high");
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe("layered role settings", () => {
  it("lets a project role override the matching global role and inherit the rest", async () => {
    const { mergeLayeredRoleBindings, roleBindingSources, resolveLayeredRoleBindings, saveProjectRoleSettings } =
      await import("../src/desktop/project-role-settings.js");
    const { saveDesktopSettings } = await import("../src/desktop/settings.js");

    const global = {
      orchestrator: { cli: "grok" as const, model: "grok-4.6", reasoning: "high" },
      architect: { cli: "grok" as const, model: "grok-4.6", reasoning: "high" },
      worker: { cli: "grok" as const, model: "grok-4.6", reasoning: "high" },
    };
    const project = {
      architect: { cli: "codex" as const, model: "gpt-5.6-sol", reasoning: "high" },
    };
    const merged = mergeLayeredRoleBindings(global, project);
    expect(merged.orchestrator).toEqual(global.orchestrator);
    expect(merged.architect).toEqual(project.architect);
    expect(merged.worker).toEqual(global.worker);
    expect(roleBindingSources(global, project)).toEqual({
      orchestrator: "global",
      architect: "project",
      worker: "global",
    });

    const home = await mkdtemp(path.join(tmpdir(), "agent-team-layered-home-"));
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-layered-root-"));
    await saveDesktopSettings({
      version: 1,
      defaults: { roles: global },
      ui: {
        showCliPickerInRunLauncher: true,
        autoDetectCliConfig: true,
        autoDetectOnFocus: true,
      },
    }, home);
    await saveProjectRoleSettings(root, ".agent-team", { version: 1, roles: project });

    const resolved = await resolveLayeredRoleBindings({
      root,
      stateDirectory: ".agent-team",
      knownRoles: ["orchestrator", "architect", "worker"],
      home,
    });
    expect(resolved).toEqual(merged);

    const explicit = await resolveLayeredRoleBindings({
      root,
      stateDirectory: ".agent-team",
      requestBindings: { worker: { cli: "kimi", model: "kimi-code", reasoning: "high" } },
      knownRoles: ["orchestrator", "architect", "worker"],
      home,
    });
    expect(explicit).toEqual({ worker: { cli: "kimi", model: "kimi-code", reasoning: "high" } });
  });

  it("does not invent bindings when neither global nor project saved a role", async () => {
    const { resolveLayeredRoleBindings } = await import("../src/desktop/project-role-settings.js");
    const home = await mkdtemp(path.join(tmpdir(), "agent-team-empty-home-"));
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-empty-root-"));
    const resolved = await resolveLayeredRoleBindings({
      root,
      stateDirectory: ".agent-team",
      knownRoles: ["orchestrator", "worker"],
      home,
    });
    expect(resolved).toBeUndefined();
  });
});

describe("kimi stream-json parser", () => {
  it("extracts assistant JSON content from stream-json lines", async () => {
    const { parseKimiStreamJson } = await import("../src/adapters/shared.js");
    const result = parseKimiStreamJson({
      command: "kimi",
      args: [],
      exitCode: 0,
      stdout: [
        `{"role":"meta","type":"system.version","version":"0.35.0"}`,
        `{"role":"assistant","content":"{\\"answer\\":\\"ok\\"}"}`,
        `{"role":"meta","type":"session.resume_hint","content":"resume"}`,
      ].join("\n"),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      signal: null,
    });
    expect(result.structured).toEqual({ answer: "ok" });
    expect(result.text).toContain("answer");
  });
});
