import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanCliInventory } from "../src/desktop/cli-inventory.js";
import { materializeRoleBindings } from "../src/desktop/role-bindings.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { suggestDefaultsFromInventory } from "../src/desktop/settings.js";

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

  it("rejects kimi bindings until runtime adapter exists", () => {
    const config = createDefaultConfig("fixture");
    expect(() =>
      materializeRoleBindings(config, {
        orchestrator: { cli: "kimi", model: "kimi-code" },
      }),
    ).toThrow(/Kimi/);
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
          runtimeSupported: false,
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
    expect(defaults.orchestrator?.cli).toBe("grok");
    expect(defaults.worker?.cli).toBe("grok");
  });
});
