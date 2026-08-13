import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { buildInteropManifest } from "../src/interop/manifest.js";
import {
  assertDiagnosticProfilePermission,
  assertRoleProfilePermission,
} from "../src/security/permissions.js";

describe("adapter and protocol boundaries", () => {
  it("publishes stable adapter contracts and explicit MCP/A2A modes", () => {
    const manifest = buildInteropManifest(createDefaultConfig("fixture"));

    expect(manifest.adapters.map((adapter) => adapter.name)).toEqual([
      "claude",
      "codex",
      "grok",
      "kimi",
    ]);
    expect(manifest.adapters.every((adapter) => adapter.transport === "local-process")).toBe(true);
    expect(manifest.protocols.mcp).toMatchObject({
      specification: "2026-07-28",
      mode: "profile-controlled",
      defaultPolicy: "deny",
      executionOwner: "agent-cli",
    });
    expect(manifest.protocols.a2a).toMatchObject({
      specification: "1.0",
      mode: "disabled",
    });
    expect(manifest.configuredProfiles.every((profile) => profile.externalTools === "deny")).toBe(
      true,
    );
  });

  it("allows workspace writes only for workflow workers, never diagnostics", () => {
    expect(() =>
      assertRoleProfilePermission("reviewer", "writer", "workspace-write"),
    ).toThrow("Role 'reviewer' cannot use workspace-write profile 'writer'");
    expect(() =>
      assertDiagnosticProfilePermission("worker", "writer", "workspace-write"),
    ).toThrow("Diagnostic invocation for role 'worker'");
    expect(() => assertRoleProfilePermission("worker", "writer", "workspace-write")).not.toThrow();
  });
});
