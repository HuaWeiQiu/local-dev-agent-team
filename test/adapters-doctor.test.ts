import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AdapterDoctorSpec } from "../src/adapters/types.js";
import type { AgentProfile } from "../src/config/schema.js";

const process = vi.hoisted(() => ({ runProcess: vi.fn() }));
vi.mock("../src/process/run.js", () => process);

const { runAdapterDoctor } = await import("../src/adapters/shared.js");

function profile(patch: Partial<AgentProfile> = {}): AgentProfile {
  return {
    adapter: "kimi",
    model: "kimi-k2",
    reasoning: "high",
    permission: "workspace-write",
    externalTools: "deny",
    timeoutSeconds: 600,
    args: [],
    ...patch,
  } as AgentProfile;
}

function adapter(patch: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: "kimi",
    supportedReasoning: ["low", "high"],
    promptTransport: "argv",
    buildInvocation: () => ({ command: "kimi", args: [], cwd: "/tmp" }),
    parseResult: async () => ({ ok: true }),
    ...patch,
  } as unknown as AgentAdapter;
}

function spec(patch: Partial<AdapterDoctorSpec> = {}): AdapterDoctorSpec {
  return {
    executableFallback: "kimi-bin",
    authArgs: ["auth", "status"],
    authPassDetail: "已登录",
    displayName: "Kimi",
    prepareProbeProfile: (input) => input,
    ...patch,
  } as AdapterDoctorSpec;
}

function options(patch: Record<string, unknown> = {}) {
  return { profileName: "fast", cwd: "/repo", profile: profile(), ...patch } as never;
}

function result(patch: Record<string, unknown> = {}) {
  return { command: "kimi", args: [], cwd: "/repo", exitCode: 0, stdout: "", stderr: "", durationMs: 1, ...patch };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.runProcess.mockResolvedValue(result());
});

describe("runAdapterDoctor", () => {
  it("passes every check for a healthy adapter", async () => {
    process.runProcess.mockResolvedValueOnce(result({ stdout: "kimi 1.2.3" }));
    const checks = await runAdapterDoctor(adapter(), options(), spec());
    expect(checks.map((check) => check.check)).toEqual([
      "executable",
      "authentication",
      "capability",
      "model",
    ]);
    expect(checks[0]).toMatchObject({ status: "pass", detail: "kimi 1.2.3" });
    expect(checks[1]).toMatchObject({ status: "pass", detail: "已登录" });
    expect(checks[3]).toMatchObject({ status: "skip" });
  });

  it("stops after a missing executable", async () => {
    process.runProcess.mockRejectedValueOnce(new Error("ENOENT"));
    const checks = await runAdapterDoctor(adapter(), options(), spec());
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: "fail", detail: "kimi-bin not found" });
  });

  it("reports a failing executable with its stderr", async () => {
    process.runProcess.mockResolvedValueOnce(result({ exitCode: 1, stderr: "boom" }));
    const checks = await runAdapterDoctor(adapter(), options(), spec());
    expect(checks[0]).toMatchObject({ status: "fail", detail: "boom" });
  });

  it("uses the adapter's own auth validator and reports capability gaps", async () => {
    process.runProcess
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: "no token" }));
    const checks = await runAdapterDoctor(
      adapter(),
      options({ profile: profile({ reasoning: "max" }) }),
      spec({ validateAuth: () => ({ ok: false, detail: "需要登录" }) }),
    );
    expect(checks[1]).toMatchObject({ status: "fail", detail: "需要登录" });
    expect(checks[2]).toMatchObject({ status: "fail", detail: "Unsupported reasoning 'max'" });
  });

  it("falls back to stderr when the auth command fails", async () => {
    process.runProcess
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ exitCode: 2, stderr: "expired" }));
    const checks = await runAdapterDoctor(adapter(), options(), spec());
    expect(checks[1]).toMatchObject({ status: "fail", detail: "expired" });
  });

  it("probes the model when requested", async () => {
    process.runProcess
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ stdout: "OK" }));
    const checks = await runAdapterDoctor(adapter(), options({ probeModel: true }), spec());
    expect(checks[3]).toMatchObject({ status: "pass", detail: "Model 'kimi-k2' accepted by Kimi" });
  });

  it("fails the probe on a non-zero exit or unparsable output", async () => {
    process.runProcess
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: "rate limited" }));
    const failed = await runAdapterDoctor(adapter(), options({ probeModel: true }), spec());
    expect(failed[3]).toMatchObject({ status: "fail", detail: "rate limited" });

    process.runProcess
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());
    const unparsable = await runAdapterDoctor(
      adapter({ parseResult: async () => { throw new Error("bad json"); } }),
      options({ probeModel: true }),
      spec(),
    );
    expect(unparsable[3].status).toBe("fail");
    expect(unparsable[3].detail).toContain("bad json");
  });

  it("writes a prompt file when the adapter transports prompts by file", async () => {
    process.runProcess
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());
    const buildInvocation = vi.fn(() => ({ command: "kimi", args: [], cwd: "/repo" }));
    const checks = await runAdapterDoctor(
      adapter({ promptTransport: "file", buildInvocation } as never),
      options({ probeModel: true }),
      spec(),
    );
    expect(checks[3].status).toBe("pass");
    expect(buildInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "read-only", externalTools: "deny", args: [] }),
      expect.objectContaining({ promptFile: expect.stringContaining("prompt.txt") }),
    );
  });
});
