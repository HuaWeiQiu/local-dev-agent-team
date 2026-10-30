import { describe, expect, it } from "vitest";
import {
  authLabel,
  authTone,
  cacheSourceLabel,
  cliIndex,
  globalSettingsPayload,
  inheritedBinding,
  noticeFor,
  projectRolePayload,
  projectStateOf,
  roleNamesFor,
  shortPath,
  syncRoleBindings,
  uiStateOf,
  type UiState,
} from "../../web/src/components/settings/model.js";
import type {
  CliId,
  CliProbeResult,
  DesktopSettingsResponse,
  DesktopSettingsView,
  ProjectRoleSettingsView,
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

function settings(patch: Partial<DesktopSettingsView> = {}): DesktopSettingsView {
  return {
    version: 1,
    defaults: { roles: {} },
    ui: { showCliPickerInRunLauncher: true },
    inventoryCachedAt: null,
    ...patch,
  };
}

function response(patch: Partial<DesktopSettingsResponse> = {}): DesktopSettingsResponse {
  return {
    settings: settings(),
    inventory: { scannedAt: "2026-10-30T00:00:00.000Z", home: "/h", clis: [cli()] },
    fromCache: false,
    suggestedDefaults: {},
    ...patch,
  };
}

describe("settings model", () => {
  it("snaps a role binding onto what the CLI still offers", () => {
    const byId = new Map<CliId, CliProbeResult>([["kimi", cli()]]);
    const stale: Record<string, RoleBindingInput> = {
      worker: { cli: "kimi", model: "gone", reasoning: "gone" },
    };
    const synced = syncRoleBindings(stale, byId);
    expect(synced.changed).toBe(true);
    expect(synced.roles.worker).toEqual({ cli: "kimi", model: "m1", reasoning: "high" });
  });

  it("keeps state identity when nothing needs snapping", () => {
    const byId = new Map<CliId, CliProbeResult>([["kimi", cli()]]);
    const current: Record<string, RoleBindingInput> = {
      worker: { cli: "kimi", model: "m1", reasoning: "high" },
    };
    const synced = syncRoleBindings(current, byId);
    expect(synced.changed).toBe(false);
    expect(synced.roles).toBe(current);
  });

  it("keeps a valid reasoning level and falls back when the model offers none", () => {
    const byId = new Map<CliId, CliProbeResult>([
      ["kimi", cli()],
      [
        "grok",
        cli({ id: "grok", models: [{ id: "g1", label: "g1", reasoningOptions: [] }], defaultModel: "g1" }),
      ],
      [
        "codex",
        cli({
          id: "codex",
          models: [{ id: "c1", label: "c1", reasoningOptions: ["low"] }],
          defaultModel: "c1",
          defaultReasoning: undefined,
        }),
      ],
    ]);

    // Valid reasoning stays untouched.
    expect(
      syncRoleBindings({ worker: { cli: "kimi", model: "m1", reasoning: "high" } }, byId).changed,
    ).toBe(false);

    // Unknown model with a CLI default snaps to the default model and level.
    const snapped = syncRoleBindings(
      { worker: { cli: "kimi", model: "nope", reasoning: "gone" } },
      byId,
    );
    expect(snapped.roles.worker).toEqual({ cli: "kimi", model: "m1", reasoning: "high" });

    // A model the CLI does not list has no options: keep the level as-is.
    const unknownModel = syncRoleBindings(
      { worker: { cli: "kimi", model: "m1", reasoning: "medium" } },
      byId,
    );
    expect(unknownModel.roles.worker).toEqual({ cli: "kimi", model: "m1", reasoning: "high" });

    // A model with no reasoning options leaves the level alone.
    const noOptions = syncRoleBindings(
      { worker: { cli: "grok", model: "gone", reasoning: "high" } },
      byId,
    );
    expect(noOptions.roles.worker).toEqual({ cli: "grok", model: "g1", reasoning: "high" });

    // No CLI default reasoning: fall back to the first offered option.
    const firstOption = syncRoleBindings(
      { worker: { cli: "codex", model: "c1", reasoning: "max" } },
      byId,
    );
    expect(firstOption.roles.worker).toEqual({ cli: "codex", model: "c1", reasoning: "low" });
  });

  it("ignores roles whose CLI is not in the inventory", () => {
    const synced = syncRoleBindings({ worker: { cli: "grok" } }, new Map());
    expect(synced.changed).toBe(false);
  });

  it("explains each settings response in operator language", () => {
    expect(noticeFor(response({ reason: "fingerprint" }), undefined, false)).toMatch(
      /配置文件已变更/,
    );
    expect(noticeFor(response({ reason: "stale" }), undefined, false)).toMatch(/缓存已过期/);
    expect(noticeFor(response({ reason: "miss" }), undefined, false)).toMatch(/首次/);
    expect(noticeFor(response({ reason: "hit" }), undefined, false)).toBeUndefined();
    expect(noticeFor(response({ reason: "hit" }), { quiet: true }, false)).toBeUndefined();
    expect(noticeFor(response({ reason: "hit" }), undefined, true)).toMatch(/已保留/);
  });

  it("clears project overrides the project does not own", () => {
    const payload = projectRolePayload(
      ["worker", "reviewer"],
      { worker: "project" },
      { worker: { cli: "kimi" }, reviewer: { cli: "grok" } },
    );
    expect(payload).toEqual({ worker: { cli: "kimi" }, reviewer: null });
  });

  it("normalises the global payload so undefined toggles mean enabled", () => {
    const ui: UiState = { showCliPickerInRunLauncher: true };
    expect(globalSettingsPayload({}, ui)).toEqual({
      defaults: { roles: {} },
      ui: {
        showCliPickerInRunLauncher: true,
        autoDetectCliConfig: true,
        autoDetectOnFocus: true,
      },
    });
  });

  it("falls back to the global binding when a project role is restored", () => {
    expect(inheritedBinding({ cli: "kimi" }, { cli: "grok" })).toEqual({ cli: "kimi" });
    expect(inheritedBinding(undefined, { cli: "grok" })).toEqual({ cli: "grok" });
    expect(inheritedBinding(undefined, undefined)).toEqual({ cli: "grok", reasoning: "high" });
  });

  it("labels auth, cache and long paths", () => {
    expect(authTone("present")).toBe("success");
    expect(authTone("missing")).toBe("warning");
    expect(authTone("invalid")).toBe("danger");
    expect(authTone("unknown")).toBe("neutral");
    expect(authLabel("invalid")).toBe("授权无效");
    expect(authLabel("unknown")).toBe("未知");
    expect(shortPath("short")).toBe("short");
    expect(shortPath("x".repeat(60))).toHaveLength(41);
    expect(cacheSourceLabel(true, "miss")).toMatch(/缓存/);
    expect(cacheSourceLabel(false, "hit")).toMatch(/缓存（配置未变）/);
    expect(cacheSourceLabel(false, "stale")).toMatch(/缓存过期/);
    expect(cacheSourceLabel(false, "refresh")).toBe("强制检索");
    expect(cacheSourceLabel(false, "miss")).toBe("首次检索");
    expect(cacheSourceLabel(false, undefined)).toBe("实时");
    expect(cacheSourceLabel(false, "other")).toBe("实时");
  });

  it("orders role names and falls back to the built-in set", () => {
    const ordered = (names: string[]): string[] => [...new Set(names)].sort();
    expect(
      roleNamesFor({ worker: { cli: "kimi" } }, { custom: { cli: "grok" } }, {}, ordered),
    ).toEqual(["custom", "worker"]);
    expect(roleNamesFor({}, {}, {}, ordered)).toContain("orchestrator");
  });

  it("projects the layered response and indexes CLIs", () => {
    const layered: ProjectRoleSettingsView = {
      projectId: "p1",
      projectName: "demo",
      effective: { worker: { cli: "kimi" } },
      sources: { worker: "project" },
      overrides: { worker: { cli: "kimi" } },
    };
    const state = projectStateOf(layered);
    expect(state.roles).toEqual({ worker: { cli: "kimi" } });
    expect(state).not.toBe(layered.effective);

    expect(cliIndex(undefined).size).toBe(0);
    expect(cliIndex(response().inventory).get("kimi")?.installed).toBe(true);
    expect(uiStateOf(undefined)).toMatchObject({ autoDetectCliConfig: true });
    expect(uiStateOf(settings({ ui: { showCliPickerInRunLauncher: false } }))).toEqual({
      showCliPickerInRunLauncher: false,
    });
  });
});
