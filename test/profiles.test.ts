import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/defaults.js";
import { resolveProfile } from "../src/profiles/resolve.js";
import { requestedProfileForRole } from "../src/agents/service.js";

describe("profile resolution", () => {
  it("uses a role default", () => {
    const result = resolveProfile(createDefaultConfig("fixture"), "worker");
    expect(result.name).toBe("codex-worker");
    expect(result.profile.permission).toBe("workspace-write");
  });

  it("rejects a profile outside the role allowlist", () => {
    expect(() =>
      resolveProfile(createDefaultConfig("fixture"), "architect", "codex-worker"),
    ).toThrow("not allowed");
  });

  it("keeps an explicit human override above a task-suggested profile", () => {
    expect(
      requestedProfileForRole(
        "worker",
        { worker: "human-selected" },
        "task-suggested",
      ),
    ).toBe("human-selected");
  });
});
