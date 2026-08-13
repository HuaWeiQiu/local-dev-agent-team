import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inventorySourceFingerprint,
  scanCliInventory,
} from "../src/desktop/cli-inventory.js";
import {
  materializeRoleBindings,
  parseRuntimeProfileName,
  roleBindingsFromRunState,
} from "../src/desktop/role-bindings.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import {
  getInventory,
  sanitizeRoleBindings,
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
      `[model.grok]\nmodel = "grok"\napi_key = "xai-secret"\n`,
      "utf8",
    );

    const inventory = await scanCliInventory(home);
    const json = JSON.stringify(inventory);
    expect(json).not.toContain("sk-secret");
    expect(json).not.toContain("xai-secret");

    const codex = inventory.clis.find((cli) => cli.id === "codex");
    expect(codex?.auth.status).toBe("present");
    expect(codex?.defaultModel).toBe("gpt-5.6-sol");
    expect(codex?.providers?.some((p) => p.id === "sub2api")).toBe(true);

    const grok = inventory.clis.find((cli) => cli.id === "grok");
    expect(grok?.auth.status).toBe("present");
    expect(grok?.auth.detail).toMatch(/api_key/);
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

    const first = await getInventory({ home, maxAgeMs: 60 * 60 * 1000 });
    expect(first.fromCache).toBe(false);
    expect(first.reason).toBe("miss");
    expect(first.inventory.sourceFingerprint).toBeTruthy();
    expect(first.inventory.clis.find((cli) => cli.id === "codex")?.defaultModel).toBe("gpt-old");

    const second = await getInventory({ home, maxAgeMs: 60 * 60 * 1000 });
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

    const third = await getInventory({ home, maxAgeMs: 60 * 60 * 1000 });
    expect(third.fromCache).toBe(false);
    expect(third.reason).toBe("fingerprint");
    expect(third.inventory.clis.find((cli) => cli.id === "codex")?.defaultModel).toBe("gpt-new");
    expect(third.inventory.clis.find((cli) => cli.id === "codex")?.defaultReasoning).toBe("high");
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
