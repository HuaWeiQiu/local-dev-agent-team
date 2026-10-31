import { describe, expect, it } from "vitest";
import {
  applyBindingPatch,
  approvalSummary,
  cliDisabled,
  cliIndex,
  cliOptionLabel,
  fallbackBindingFor,
  formatDuration,
  initialBindings,
  initialStrategy,
  modelOptions,
  reasoningOptionsFor,
  shouldUseCliPicker,
  startRunInput,
  templateHint,
} from "../../web/src/components/run-launcher/model.js";
import type {
  CliId,
  CliInventory,
  CliProbeResult,
  PublicConfig,
  RoleBindingInput,
} from "../../web/src/types.js";

function cli(patch: Partial<CliProbeResult> = {}): CliProbeResult {
  return {
    id: "kimi",
    installed: true,
    auth: { status: "present" },
    configPaths: [],
    models: [
      { id: "m1", label: "m1", reasoningOptions: ["low", "high"] },
      { id: "m2", label: "m2", reasoningOptions: ["medium"] },
    ],
    defaultModel: "m1",
    defaultReasoning: "high",
    runtimeSupported: true,
    ...patch,
  };
}

function inventory(clis: CliProbeResult[]): CliInventory {
  return { scannedAt: "2026-10-30T00:00:00.000Z", home: "/h", clis };
}

describe("run launcher model", () => {
  it("picks the first runtime-capable CLI as the fallback binding", () => {
    expect(fallbackBindingFor(undefined)).toEqual({ cli: "grok", model: "grok", reasoning: "high" });
    expect(
      fallbackBindingFor(
        inventory([
          cli({ id: "codex", installed: false }),
          cli({ id: "kimi", defaultModel: "m1" }),
        ]),
      ),
    ).toEqual({ cli: "kimi", model: "m1", reasoning: "high" });
    expect(
      fallbackBindingFor(inventory([cli({ id: "claude", defaultModel: undefined, defaultReasoning: undefined })])),
    ).toEqual({ cli: "claude", reasoning: "high" });
  });

  it("only enables the picker when a usable CLI exists", () => {
    expect(shouldUseCliPicker(true, undefined)).toBe(false);
    expect(shouldUseCliPicker(false, inventory([cli()]))).toBe(false);
    expect(shouldUseCliPicker(true, inventory([cli({ installed: false })]))).toBe(false);
    expect(shouldUseCliPicker(true, inventory([cli()]))).toBe(true);
  });

  it("seeds bindings from defaults and indexes the inventory", () => {
    const fallback: RoleBindingInput = { cli: "grok", reasoning: "high" };
    expect(initialBindings(["worker", "reviewer"], { worker: { cli: "kimi" } }, fallback)).toEqual({
      worker: { cli: "kimi" },
      reviewer: fallback,
    });
    expect(cliIndex(inventory([cli()])).get("kimi")?.installed).toBe(true);
    expect(cliIndex(undefined).size).toBe(0);
  });

  it("keeps the requested strategy only when it is defined", () => {
    const config = {
      strategies: { default: "demo", definitions: { demo: {}, tighten: {} } },
    } as unknown as PublicConfig;
    expect(initialStrategy(config, "tighten")).toBe("tighten");
    expect(initialStrategy(config, "missing")).toBe("demo");
    expect(initialStrategy(config, undefined)).toBe("demo");
  });

  it("re-seats model and reasoning when the CLI changes", () => {
    const byId = new Map<CliId, CliProbeResult>([
      ["kimi", cli()],
      ["grok", cli({ id: "grok", models: [], defaultModel: undefined, defaultReasoning: undefined })],
    ]);
    const fallback: RoleBindingInput = { cli: "grok", reasoning: "high" };

    const switched = applyBindingPatch(
      { worker: { cli: "grok", model: "grok", reasoning: "medium" } },
      "worker",
      { cli: "kimi" },
      fallback,
      byId,
    );
    expect(switched.worker).toEqual({ cli: "kimi", model: "m1", reasoning: "high" });

    // A CLI with no models keeps the previous model and reasoning.
    const kept = applyBindingPatch(
      { worker: { cli: "kimi", model: "m1", reasoning: "high" } },
      "worker",
      { cli: "grok" },
      fallback,
      byId,
    );
    expect(kept.worker).toEqual({ cli: "grok", model: "m1", reasoning: "high" });

    // Unknown role falls back before patching.
    expect(applyBindingPatch({}, "tester", { model: "x" }, fallback, byId).tester).toEqual({
      cli: "grok",
      reasoning: "high",
      model: "x",
    });
  });

  it("derives model and reasoning options with safe defaults", () => {
    const binding: RoleBindingInput = { cli: "kimi", model: "m2" };
    expect(reasoningOptionsFor(cli(), binding)).toEqual(["medium"]);
    expect(reasoningOptionsFor(undefined, binding)).toEqual(["low", "medium", "high"]);
    expect(modelOptions(cli(), binding).map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(modelOptions(undefined, binding)).toEqual([{ id: "m2", label: "m2" }]);
    expect(modelOptions(undefined, { cli: "kimi" })).toEqual([{ id: "default", label: "默认" }]);
  });

  it("labels and disables CLI options by capability", () => {
    expect(cliOptionLabel("kimi", cli())).toBe("Kimi");
    expect(cliOptionLabel("codex", cli({ id: "codex", installed: false }))).toBe("Codex · 未装");
    expect(cliOptionLabel("grok", cli({ id: "grok", runtimeSupported: false }))).toBe(
      "Grok · 不可调用",
    );
    expect(cliDisabled(undefined)).toBe(true);
    expect(cliDisabled(cli())).toBe(false);
  });

  it("builds the start payload and drops runtime-less bindings", () => {
    const base = {
      goal: "  ship it  ",
      strategy: "demo",
      template: "auto" as const,
      useCliPicker: true,
      bindings: { worker: { cli: "kimi" as const }, ghost: { cli: "grok" as const } },
      roles: { worker: {} },
    };
    expect(startRunInput(base)).toEqual({
      goal: "ship it",
      strategy: "demo",
      profileOverrides: {},
      roleBindings: { worker: { cli: "kimi" } },
    });

    expect(
      startRunInput({ ...base, useCliPicker: false, template: "quick" }),
    ).toMatchObject({ template: "quick" });
    expect(startRunInput({ ...base, useCliPicker: false })).not.toHaveProperty("roleBindings");
  });

  it("formats durations, approval gates and template hints", () => {
    expect(formatDuration(3600)).toBe("单段 1h");
    expect(formatDuration(90)).toBe("单段 2m");
    expect(approvalSummary({ approvalGates: ["plan", "final"] })).toBe("计划+交付");
    expect(approvalSummary({})).toBe("交付");
    expect(templateHint("quick")).toMatch(/小改动/);
    expect(templateHint("auto")).toMatch(/自动/);
  });
});
