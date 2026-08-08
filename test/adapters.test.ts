import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { AgentInvocationError, invokeAgent } from "../src/adapters/invoke.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import type { AgentProfile } from "../src/config/schema.js";
import type { AgentAdapter } from "../src/adapters/types.js";

const readOnlyProfile: AgentProfile = {
  adapter: "codex",
  model: "configured-model",
  reasoning: "high",
  permission: "read-only",
  externalTools: "deny",
  timeoutSeconds: 60,
  args: [],
};

describe("Codex adapter", () => {
  it("passes explicit model and sandbox without a shell", () => {
    const invocation = new CodexAdapter().buildInvocation(readOnlyProfile, {
      cwd: "/tmp/repo",
      prompt: "Review",
    });
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toContain("configured-model");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain("project_root_markers=[]");
    expect(invocation.args).toContain(
      'projects."/tmp/repo".trust_level="untrusted"',
    );
    expect(invocation.stdin).toBe("Review");
  });

  it("inherits the CLI model when requested", () => {
    const invocation = new CodexAdapter().buildInvocation(
      { ...readOnlyProfile, model: "inherit" },
      { cwd: "/tmp/repo", prompt: "Review" },
    );
    expect(invocation.args).not.toContain("--model");
  });

  it("rejects safety overrides in profile arguments", () => {
    expect(() =>
      new CodexAdapter().buildInvocation(
        { ...readOnlyProfile, args: ["--sandbox", "danger-full-access"] },
        { cwd: "/tmp/repo", prompt: "Review" },
      ),
    ).toThrow("cannot be overridden");
    expect(() =>
      new CodexAdapter().buildInvocation(
        { ...readOnlyProfile, args: ["-cfoo=bar"] },
        { cwd: "/tmp/repo", prompt: "Review" },
      ),
    ).toThrow("managed by the codex adapter");
  });

  it("inherits provider-managed external tools only when explicitly configured", () => {
    const invocation = new CodexAdapter().buildInvocation(
      { ...readOnlyProfile, permission: "workspace-write", externalTools: "inherit" },
      { cwd: "/tmp/repo", prompt: "Review" },
    );
    expect(invocation.args).not.toContain("--ignore-user-config");
    expect(() =>
      new CodexAdapter().buildInvocation(
        { ...readOnlyProfile, externalTools: "inherit" },
        { cwd: "/tmp/repo", prompt: "Review" },
      ),
    ).toThrow("Read-only profiles cannot inherit external MCP tools");
  });

  it("rejects native profiles when user configuration is isolated", () => {
    expect(() =>
      new CodexAdapter().buildInvocation(
        { ...readOnlyProfile, nativeProfile: "personal" },
        { cwd: "/tmp/repo", prompt: "Review" },
      ),
    ).toThrow("Codex nativeProfile requires externalTools: inherit");
  });

  it("records token usage only when a JSONL event reports it", async () => {
    const adapter = new CodexAdapter();
    const invocation = adapter.buildInvocation(readOnlyProfile, {
      cwd: "/tmp/repo",
      prompt: "Review",
    });
    const processResult = fixtureProcess(
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":5}}\n',
    );

    await expect(adapter.parseResult(invocation, processResult)).resolves.toMatchObject({
      usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 },
    });
  });
});

describe("Claude adapter", () => {
  it("maps read-only profiles to plan mode", () => {
    const invocation = new ClaudeAdapter().buildInvocation(
      { ...readOnlyProfile, adapter: "claude", reasoning: "max" },
      { cwd: "/tmp/repo", prompt: "Review" },
    );
    expect(invocation.command).toBe("claude");
    expect(invocation.args).toContain("plan");
    expect(invocation.args).toContain("max");
    expect(invocation.args).toContain("Read,Glob,Grep");
    expect(invocation.args).toContain("Edit,Write,NotebookEdit,Bash");
    expect(invocation.args).toContain("--strict-mcp-config");
    expect(invocation.args).toContain('{"mcpServers":{}}');
    expect(invocation.args).not.toContain("Review");
    expect(invocation.stdin).toBe("Review");
  });

  it("records provider-reported usage and cost", async () => {
    const adapter = new ClaudeAdapter();
    const result = await adapter.parseResult(
      adapter.buildInvocation(
        { ...readOnlyProfile, adapter: "claude" },
        { cwd: "/tmp/repo", prompt: "Review" },
      ),
      fixtureProcess(JSON.stringify({
        result: "done",
        total_cost_usd: 0.012,
        usage: { input_tokens: 20, cache_read_input_tokens: 4, output_tokens: 6 },
      })),
    );

    expect(result.usage).toEqual({
      inputTokens: 20,
      cachedInputTokens: 4,
      outputTokens: 6,
      reportedCostUsd: 0.012,
    });
  });

  it("rejects Codex-native profiles", () => {
    expect(() =>
      new ClaudeAdapter().buildInvocation(
        { ...readOnlyProfile, adapter: "claude", nativeProfile: "personal" },
        { cwd: "/tmp/repo", prompt: "Review" },
      ),
    ).toThrow("nativeProfile is supported only by the Codex adapter");
  });
});

function fixtureProcess(stdout: string) {
  return {
    command: "fixture",
    args: [],
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 10,
    timedOut: false,
    signal: null,
  };
}

describe("agent invocation", () => {
  it("streams stdout and stderr into durable artifact logs", async () => {
    const artifactDirectory = await mkdtemp(path.join(tmpdir(), "agent-team-invoke-"));
    const adapter: AgentAdapter = {
      name: "fixture",
      contract: fixtureContract,
      supportedReasoning: ["high"],
      buildInvocation: (_profile, request) => ({
        command: process.execPath,
        args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: 1_000,
      }),
      parseResult: async (_invocation, processResult) => ({
        text: processResult.stdout,
        process: processResult,
      }),
      doctor: async () => [],
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await invokeAgent(
      {
        adapterName: "fixture",
        profile: { ...readOnlyProfile, adapter: "fixture" },
        cwd: artifactDirectory,
        prompt: "ignored",
        artifactDirectory,
        onStdout: (chunk) => stdout.push(chunk),
        onStderr: (chunk) => stderr.push(chunk),
      },
      new AdapterRegistry([adapter]),
    );

    expect(result.text).toBe("out");
    expect(stdout.join("")).toBe("out");
    expect(stderr.join("")).toBe("err");
    await expect(readFile(path.join(artifactDirectory, "stdout.log"), "utf8")).resolves.toBe(
      "out",
    );
    await expect(readFile(path.join(artifactDirectory, "stderr.log"), "utf8")).resolves.toBe(
      "err",
    );
  });

  it("preserves capped process metrics when an invocation fails", async () => {
    const artifactDirectory = await mkdtemp(path.join(tmpdir(), "agent-team-invoke-failure-"));
    const adapter: AgentAdapter = {
      name: "fixture",
      contract: fixtureContract,
      supportedReasoning: ["high"],
      buildInvocation: (_profile, request) => ({
        command: process.execPath,
        args: ["-e", "process.stdout.write('abcdef'); process.exit(2)"],
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: 1_000,
      }),
      parseResult: async (_invocation, processResult) => ({
        text: processResult.stdout,
        process: processResult,
      }),
      doctor: async () => [],
    };

    try {
      await invokeAgent(
        {
          adapterName: "fixture",
          profile: { ...readOnlyProfile, adapter: "fixture" },
          cwd: artifactDirectory,
          prompt: "ignored",
          artifactDirectory,
          maxOutputBytes: 4,
        },
        new AdapterRegistry([adapter]),
      );
      throw new Error("Expected invocation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentInvocationError);
      expect((error as AgentInvocationError).result.process).toMatchObject({
        exitCode: 2,
        stdout: "abcd",
        stdoutBytes: 4,
        stdoutTruncated: true,
      });
    }
  });

  it("rejects duplicate adapters and mismatched profile ownership", async () => {
    const adapter: AgentAdapter = {
      name: "fixture",
      contract: fixtureContract,
      supportedReasoning: ["high"],
      buildInvocation: (_profile, request) => ({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: 1_000,
      }),
      parseResult: async (_invocation, processResult) => ({
        text: processResult.stdout,
        process: processResult,
      }),
      doctor: async () => [],
    };
    expect(() => new AdapterRegistry([adapter, adapter])).toThrow("Duplicate agent adapter");
    await expect(
      invokeAgent(
        {
          adapterName: "fixture",
          profile: readOnlyProfile,
          cwd: process.cwd(),
          prompt: "ignored",
        },
        new AdapterRegistry([adapter]),
      ),
    ).rejects.toThrow("does not match requested adapter");
  });

  it("accepts prompts that happen to equal a process argument", async () => {
    const artifactDirectory = await mkdtemp(path.join(tmpdir(), "agent-team-invoke-prompt-"));
    const adapter: AgentAdapter = {
      name: "fixture",
      contract: fixtureContract,
      supportedReasoning: ["high"],
      buildInvocation: (_profile, request) => ({
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)", "-"],
        cwd: request.cwd,
        stdin: request.prompt,
        timeoutMs: 1_000,
      }),
      parseResult: async (_invocation, processResult) => ({
        text: processResult.stdout,
        process: processResult,
      }),
      doctor: async () => [],
    };

    await expect(
      invokeAgent(
        {
          adapterName: "fixture",
          profile: { ...readOnlyProfile, adapter: "fixture" },
          cwd: artifactDirectory,
          prompt: "-",
        },
        new AdapterRegistry([adapter]),
      ),
    ).resolves.toMatchObject({ text: "-" });
  });
});

const fixtureContract = {
  version: 1,
  transport: "local-process",
  permissions: ["read-only", "workspace-write"],
  externalTools: ["deny", "inherit"],
  structuredOutput: true,
  usage: [],
} as const;
