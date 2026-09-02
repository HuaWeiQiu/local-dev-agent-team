import { describe, expect, it } from "vitest";
import { clientBuildTooOld, CONTROL_PLANE_BUILD } from "../src/version.js";

describe("clientBuildTooOld", () => {
  it("ignores ungated routes and clients that omit a build header", () => {
    expect(clientBuildTooOld(undefined, "/health")).toBe(false);
    expect(clientBuildTooOld(undefined, "/git/status")).toBe(false);
    expect(clientBuildTooOld(CONTROL_PLANE_BUILD, "/git/status")).toBe(false);
  });

  it("rejects an explicit older frontend on gated experience APIs", () => {
    expect(clientBuildTooOld("2026.08.01-old", "/git/status")).toBe(true);
    expect(clientBuildTooOld("2026.08.01-old", "/git/changes")).toBe(true);
    expect(clientBuildTooOld("2026.08.01-old", "/git/connect")).toBe(true);
    expect(clientBuildTooOld("2026.08.01-old", "/git/commit")).toBe(true);
    expect(clientBuildTooOld("2026.08.01-old", "/git/push")).toBe(true);
    expect(clientBuildTooOld("2026.08.01-old", "/runs/x/inquiries")).toBe(true);
    expect(clientBuildTooOld("2026.08.01-old", "/runs/x/publish-preview")).toBe(true);
    expect(clientBuildTooOld("2026.08.01-old", "/health")).toBe(false);
  });
});
