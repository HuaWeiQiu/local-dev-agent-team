import { describe, expect, it } from "vitest";
import {
  assertAdapterContract,
  assertAdapterProfile,
  assertInvocationContract,
} from "../src/adapters/conformance.js";
import type {
  AgentAdapter,
  AgentInvocation,
  AgentInvocationRequest,
} from "../src/adapters/types.js";
import type { AgentProfile } from "../src/config/schema.js";

function adapter(patch: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: "fake",
    contract: {
      version: 1,
      transport: "local-process",
      permissions: ["read-only", "workspace-write"],
      externalTools: ["deny", "inherit"],
      structuredOutput: true,
      usage: ["inputTokens", "outputTokens"],
    },
    supportedReasoning: ["low", "high"],
    buildInvocation: () => ({}) as AgentInvocation,
    parseResult: async () => ({}) as never,
    doctor: async () => [],
    ...patch,
  } as AgentAdapter;
}

function profile(patch: Partial<AgentProfile> = {}): AgentProfile {
  return {
    adapter: "fake",
    model: "m",
    reasoning: "low",
    permission: "read-only",
    externalTools: "deny",
    timeoutSeconds: 60,
    args: [],
    ...patch,
  } as AgentProfile;
}

function request(patch: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return { cwd: "/repo", prompt: "hi", outputFile: "/repo/out.md", ...patch } as AgentInvocationRequest;
}

function invocation(patch: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    command: "fake-bin",
    args: [],
    cwd: "/repo",
    stdin: "hi",
    timeoutMs: 1_000,
    ...patch,
  } as AgentInvocation;
}

describe("assertAdapterContract", () => {
  it("accepts a well-formed adapter", () => {
    expect(() => assertAdapterContract(adapter())).not.toThrow();
  });

  it("rejects a bad name, contract and duplicate declarations", () => {
    expect(() => assertAdapterContract(adapter({ name: "Bad Name" }))).toThrow(/Invalid agent adapter name/);
    expect(() =>
      assertAdapterContract(adapter({ contract: { ...adapter().contract, version: 2 } as never })),
    ).toThrow(/unsupported contract/);
    expect(() =>
      assertAdapterContract(adapter({ supportedReasoning: ["low", "low"] as never })),
    ).toThrow(/unique|duplicate/i);
    expect(() =>
      assertAdapterContract(adapter({ supportedReasoning: [] as never })),
    ).toThrow(/at least one/i);
    expect(() =>
      assertAdapterContract(adapter({ supportedReasoning: ["nope"] as never })),
    ).toThrow(/unsupported reasoning level/i);
    expect(() =>
      assertAdapterContract(adapter({ contract: { ...adapter().contract, structuredOutput: "yes" } as never })),
    ).toThrow(/structured-output/);
  });
});

describe("assertAdapterProfile", () => {
  it("accepts a profile the adapter supports", () => {
    expect(() => assertAdapterProfile(adapter(), profile(), false)).not.toThrow();
  });

  it("names the first field that does not line up", () => {
    expect(() => assertAdapterProfile(adapter(), profile({ adapter: "other" }), false)).toThrow(
      /does not match requested adapter/,
    );
    expect(() => assertAdapterProfile(adapter(), profile({ nativeProfile: "x" }), false)).toThrow(
      /only by the Codex adapter/,
    );
    expect(() => assertAdapterProfile(adapter(), profile({ maxTurns: 2 }), false)).toThrow(
      /only by the Grok adapter/,
    );
    expect(() => assertAdapterProfile(adapter(), profile({ reasoning: "max" as never }), false)).toThrow(
      /does not support reasoning/,
    );
    expect(() =>
      assertAdapterProfile(adapter(), profile({ permission: "danger-full-access" }), false),
    ).toThrow(/does not support permission/);
    expect(() =>
      assertAdapterProfile(adapter(), profile({ externalTools: "allow" as never }), false),
    ).toThrow(/external-tools policy/);
    expect(() =>
      assertAdapterProfile(adapter(), profile({ permission: "read-only", externalTools: "inherit" }), false),
    ).toThrow(/cannot inherit external MCP tools/);
    expect(() =>
      assertAdapterProfile(
        adapter({ contract: { ...adapter().contract, structuredOutput: false } }),
        profile(),
        true,
      ),
    ).toThrow(/does not support structured output/);
  });
});

describe("assertInvocationContract", () => {
  it("accepts a stdin invocation that matches the request", () => {
    expect(() =>
      assertInvocationContract(adapter(), profile(), request(), invocation()),
    ).not.toThrow();
  });

  it("rejects every way the invocation can drift", () => {
    const cases: Array<[Partial<AgentInvocation>, RegExp]> = [
      [{ command: "  " }, /empty executable/],
      [{ cwd: "/other" }, /changed the managed working directory/],
      [{ stdin: "other" }, /pass the prompt through stdin/],
      [{ timeoutMs: 0 }, /invalid process timeout/],
      [{ timeoutMs: 60_001 }, /invalid process timeout/],
      [{ outputFile: "/repo/other.md" }, /changed the managed output path/],
    ];
    for (const [patch, expected] of cases) {
      expect(() =>
        assertInvocationContract(adapter(), profile(), request(), invocation(patch)),
      ).toThrow(expected);
    }
  });

  it("delivers a file prompt exactly once", () => {
    const fileAdapter = adapter({ promptTransport: "file" });
    const fileRequest = request({ promptFile: "/repo/prompt.md" });
    const good = invocation({ promptFile: "/repo/prompt.md", stdin: undefined });
    expect(() =>
      assertInvocationContract(fileAdapter, profile(), fileRequest, good),
    ).not.toThrow();
    expect(() =>
      assertInvocationContract(fileAdapter, profile(), fileRequest, invocation({ promptFile: "/repo/other.md", stdin: undefined })),
    ).toThrow(/changed the managed prompt path/);
    expect(() =>
      assertInvocationContract(fileAdapter, profile(), fileRequest, invocation({ promptFile: "/repo/prompt.md", stdin: "hi" })),
    ).toThrow(/must not duplicate a file-delivered prompt/);
  });
});
