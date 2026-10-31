import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorCheck } from "../src/adapters/types.js";

const stubs = vi.hoisted(() => ({
  doctor: vi.fn(),
  plan: vi.fn(),
  quality: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../src/adapters/registry.js", () => ({
  AdapterRegistry: class {
    get(name: string) {
      return stubs.get(name);
    }
  },
}));

vi.mock("../src/sessions/factory.js", () => ({
  SessionFactory: class {
    plan(...args: unknown[]) {
      return stubs.plan(...args);
    }
  },
}));

vi.mock("../src/quality/optional-tools.js", () => ({
  qualityCommandAvailability: (...args: unknown[]) => stubs.quality(...args),
}));

const { runDoctor } = await import("../src/doctor.js");

function check(patch: Partial<DoctorCheck> = {}): DoctorCheck {
  return {
    profile: "fast",
    adapter: "codex",
    check: "executable",
    status: "pass",
    detail: "",
    ...patch,
  } as DoctorCheck;
}

function loaded(profiles: Record<string, unknown> = { fast: { adapter: "codex" }, slow: { adapter: "kimi" } }) {
  return {
    root: "/repo",
    config: { profiles, quality: { commands: ["pnpm test"] } },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.get.mockReturnValue({ doctor: stubs.doctor });
  stubs.doctor.mockImplementation(async (input: { profileName: string }) => [
    check({ profile: input.profileName }),
  ]);
  stubs.quality.mockResolvedValue([]);
  stubs.plan.mockResolvedValue({
    kind: "interactive",
    version: "1.0",
    capabilities: { streaming: true, resume: false },
  });
});

describe("runDoctor", () => {
  it("runs every profile and appends the session plan", async () => {
    const checks = await runDoctor(loaded(), { probeModel: false }, undefined, undefined);
    expect(checks.filter((entry) => entry.check === "executable")).toHaveLength(2);
    const session = checks.filter((entry) => entry.check === "session");
    expect(session).toHaveLength(2);
    expect(session[0]).toMatchObject({ status: "pass", detail: "interactive 1.0: streaming" });
  });

  it("limits to one profile and rejects an unknown name", async () => {
    const checks = await runDoctor(
      loaded(),
      { probeModel: false, profileName: "slow" },
      undefined,
      undefined,
    );
    const profileChecks = checks.filter((entry) => entry.check !== "quality-command");
    expect(profileChecks.every((entry) => entry.profile === "slow")).toBe(true);
    expect(stubs.doctor).toHaveBeenCalledTimes(1);
    await expect(
      runDoctor(loaded(), { probeModel: false, profileName: "ghost" }, undefined, undefined),
    ).rejects.toThrow(/Unknown profile 'ghost'/);
  });

  it("skips the session plan when the executable failed", async () => {
    stubs.doctor.mockResolvedValue([check({ status: "fail", detail: "missing" })]);
    const checks = await runDoctor(loaded({ fast: { adapter: "codex" } }), { probeModel: false }, undefined, undefined);
    expect(checks.some((entry) => entry.check === "session")).toBe(false);
    expect(stubs.plan).not.toHaveBeenCalled();
  });

  it("marks a one-shot plan with its reason", async () => {
    stubs.plan.mockResolvedValue({
      kind: "one-shot",
      reason: "no session support",
      capabilities: {},
    });
    const checks = await runDoctor(loaded({ fast: { adapter: "codex" } }), { probeModel: false }, undefined, undefined);
    const session = checks.find((entry) => entry.check === "session");
    expect(session).toMatchObject({ status: "skip", detail: "one-shot invocation (no session support)" });
  });

  it("marks a one-shot plan without a reason as passing", async () => {
    stubs.plan.mockResolvedValue({ kind: "one-shot", capabilities: {} });
    const checks = await runDoctor(loaded({ fast: { adapter: "codex" } }), { probeModel: false }, undefined, undefined);
    const session = checks.find((entry) => entry.check === "session");
    expect(session).toMatchObject({ status: "pass", detail: "one-shot invocation" });
  });

  it("reports optional quality commands, missing or present", async () => {
    stubs.quality.mockResolvedValue([
      { command: "ocr", available: true },
      { command: "tesseract", available: false, hint: "install it" },
      { command: "pdftotext", available: false },
    ]);
    const checks = await runDoctor(loaded({ fast: { adapter: "codex" } }), { probeModel: false }, undefined, undefined);
    const quality = checks.filter((entry) => entry.check === "quality-command");
    expect(quality).toHaveLength(3);
    expect(quality[1]).toMatchObject({ status: "fail", detail: "install it" });
    expect(quality[2]?.detail).toContain("was not found on PATH");
  });
});
