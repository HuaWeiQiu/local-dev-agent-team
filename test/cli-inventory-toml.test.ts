import { describe, expect, it } from "vitest";
import {
  apiKeyAuth,
  claudeSettings,
  codexConfig,
  kimiConfig,
  grokDefaultModel,
  grokModels,
  matchTomlString,
  matchTomlTables,
  missingConfigAuth,
} from "../src/desktop/cli-inventory.js";

describe("matchTomlString", () => {
  it("reads a top-level key", () => {
    expect(matchTomlString('model = "gpt-5"\n', "model")).toBe("gpt-5");
    expect(matchTomlString("model = 'single'\n", "model")).toBe("single");
  });

  it("reads a scoped key", () => {
    const text = '[models]\ndefault = "fast"\n';
    expect(matchTomlString(text, "default", "models")).toBe("fast");
    expect(matchTomlString(text, "default", "other")).toBeNull();
  });

  it("returns null when the key is absent", () => {
    expect(matchTomlString("", "model")).toBeNull();
    expect(matchTomlString("other = 1\n", "model")).toBeNull();
  });
});

describe("matchTomlTables", () => {
  it("collects fields per table header", () => {
    const text = [
      "[model_providers.openai]",
      'base_url = "https://api.example"',
      'wire_api = "responses"',
      "",
      "[model_providers.local]",
      'base_url = "http://127.0.0.1:1234"',
    ].join("\n");
    const blocks = matchTomlTables(text, "model_providers");
    expect(blocks.map((block) => block.id)).toEqual(["openai", "local"]);
    expect(blocks[0]!.fields.base_url).toBe("https://api.example");
    expect(blocks[1]!.fields.wire_api).toBeUndefined();
  });

  it("returns nothing without a section", () => {
    expect(matchTomlTables('[model."grok"]\nname = "x"', "model_providers")).toEqual([]);
  });
});

describe("codexConfig", () => {
  it("reads the default model, reasoning and providers", () => {
    const text = [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "high"',
      "[model_providers.local]",
      'base_url = "http://localhost"',
    ].join("\n");
    const parsed = codexConfig(text);
    expect(parsed.defaultModel).toBe("gpt-5.5");
    expect(parsed.defaultReasoning).toBe("high");
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({ id: "gpt-5.5" });
  });

  it("still offers the suggested models", () => {
    const parsed = codexConfig("");
    expect(parsed.defaultModel).toBeUndefined();
    expect(parsed.models.map((model) => model.id)).toContain("o3");
    expect(parsed.providers).toEqual([]);
  });
});

describe("grok helpers", () => {
  it("resolves the default model from any accepted key", () => {
    expect(grokDefaultModel('[models]\ndefault = "grok-4.6"\n')).toBe("grok-4.6");
    // The bare alias only appears inside a [model.grok] table.
    expect(grokDefaultModel('[model.grok]\nmodel = "grok"\n')).toBe("grok-4.6");
    expect(grokDefaultModel("")).toBeUndefined();
  });

  it("lists configured models and falls back to the default", () => {
    const text = ['[model."grok-4.6"]', 'name = "Grok 4.6"'].join("\n");
    expect(grokModels(text)[0]).toMatchObject({ id: "grok-4.6" });
    expect(grokModels("")).toHaveLength(1);
    expect(grokModels("")[0]!.id).toBe("grok-4.6");
  });
});

describe("auth helpers", () => {
  it("detects an api key without reading it", () => {
    expect(apiKeyAuth('api_key = "sk-123"').status).toBe("present");
    expect(apiKeyAuth("nothing here").status).toBe("missing");
  });

  it("explains a missing config by install state", () => {
    expect(missingConfigAuth("/bin/grok", "grok", "~/.grok/config.toml").detail).toContain(
      "~/.grok/config.toml",
    );
    expect(missingConfigAuth(undefined, "grok", "~/.grok/config.toml").detail).toContain(
      "未安装 grok",
    );
  });
});

describe("kimiConfig", () => {
  it("reads the default model, reasoning and provider key", () => {
    const text = [
      'default_model = "kimi-k2"',
      "[thinking]",
      'effort = "high"',
      "[providers.main]",
      'api_key = "sk-1"',
      "[models.kimi-k2]",
      'display_name = "Kimi K2"',
      'provider = "main"',
    ].join("\n");
    const parsed = kimiConfig(text);
    expect(parsed.defaultModel).toBe("kimi-k2");
    expect(parsed.defaultReasoning).toBe("high");
    expect(parsed.auth.status).toBe("present");
    expect(parsed.models[0]).toMatchObject({ id: "kimi-k2", provider: "main" });
  });

  it("reports a missing provider key", () => {
    expect(kimiConfig('default_model = "kimi"').auth.status).toBe("missing");
    expect(kimiConfig("").models).toEqual([]);
  });
});

describe("claudeSettings", () => {
  it("reads the model and available models", () => {
    const parsed = claudeSettings(
      JSON.stringify({ model: "sonnet", availableModels: ["sonnet", { id: "opus" }, 3] }),
    );
    expect(parsed.defaultModel).toBe("sonnet");
    expect(parsed.models.map((model) => model.id)).toEqual(["sonnet", "opus"]);
    expect(parsed.auth.status).toBe("present");
  });

  it("reports an unparseable file as unknown", () => {
    const parsed = claudeSettings("not json");
    expect(parsed.auth.status).toBe("unknown");
    expect(parsed.models).toEqual([]);
  });

  it("handles a settings file without a model", () => {
    const parsed = claudeSettings(JSON.stringify({}));
    expect(parsed.defaultModel).toBeUndefined();
    expect(parsed.models).toEqual([]);
  });
});

describe("whichOne", () => {
  it("reports nothing for a name that is not installed", async () => {
    const { whichOne } = await import("../src/desktop/cli-inventory.js");
    await expect(whichOne("definitely-not-installed-cli-xyz")).resolves.toBeUndefined();
  });
});

describe("cliResult", () => {
  it("omits what the probe did not find", async () => {
    const { cliResult } = await import("../src/desktop/cli-inventory.js");
    const bare = cliResult({
      id: "x",
      binary: undefined,
      version: undefined,
      auth: { status: "missing", detail: "d" } as never,
      configPaths: [],
      models: [],
    });
    expect(bare).toMatchObject({ id: "x", installed: false, runtimeSupported: true });
    expect(bare).not.toHaveProperty("binary");
    expect(bare).not.toHaveProperty("version");
  });

  it("carries the found binary, version and extras", async () => {
    const { cliResult } = await import("../src/desktop/cli-inventory.js");
    const full = cliResult({
      id: "y",
      binary: "/bin/y",
      version: "1.2.3",
      auth: { status: "present", detail: "d" } as never,
      configPaths: ["/c"],
      models: [],
      extra: { defaultModel: "m" },
    });
    expect(full).toMatchObject({ binary: "/bin/y", version: "1.2.3", defaultModel: "m" });
  });
});
