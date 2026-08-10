import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GrokAdapter } from "../src/adapters/grok.js";
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

  it("supports max reasoning for the explicit 5.6 Sol orchestrator profile", () => {
    const invocation = new CodexAdapter().buildInvocation(
      { ...readOnlyProfile, model: "gpt-5.6-sol", reasoning: "max" },
      { cwd: "/tmp/repo", prompt: "Coordinate" },
    );
    expect(invocation.args).toContain("gpt-5.6-sol");
    expect(invocation.args).toContain('model_reasoning_effort="max"');
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

describe("Grok adapter", () => {
  const workerProfile: AgentProfile = {
    adapter: "grok",
    model: "grok",
    reasoning: "high",
    permission: "workspace-write",
    externalTools: "deny",
    maxTurns: 16,
    timeoutSeconds: 1_800,
    args: [],
  };

  it("runs the Grok model as an isolated workspace worker", () => {
    const invocation = new GrokAdapter().buildInvocation(workerProfile, {
      cwd: "/tmp/repo",
      prompt: "Implement",
      promptFile: "/tmp/managed-prompt.txt",
    });

    expect(invocation.command).toBe("grok");
    expect(invocation.args).toContain("grok");
    expect(invocation.args).toContain("workspace");
    expect(invocation.args).toContain("--always-approve");
    expect(invocation.args).not.toContain("acceptEdits");
    expect(invocation.args).toContain("--no-memory");
    expect(invocation.args).toContain("--no-subagents");
    expect(invocation.args).toContain("--disable-web-search");
    expect(invocation.args).toContain("--no-auto-update");
    expect(invocation.args).toContain("--disallowed-tools");
    expect(invocation.args).toContain("MCPTool(*)");
    expect(invocation.args).toContain("16");
    expect(invocation.args).not.toContain("--rules");
    expect(invocation.args).toContain("read_file,grep,list_dir,search_replace,run_terminal_cmd");
    expect(invocation.args.at(-1)).toBe("/tmp/managed-prompt.txt");
    expect(invocation.promptFile).toBe("/tmp/managed-prompt.txt");
    expect(invocation.stdin).toBeUndefined();
    expect(invocation.env).toMatchObject({
      HOME: "/tmp",
      USERPROFILE: "/tmp",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
    });
  });

  it("uses a read-only sandbox for diagnostic model probes", () => {
    const invocation = new GrokAdapter().buildInvocation(
      { ...workerProfile, permission: "read-only" },
      {
        cwd: "/tmp/repo",
        prompt: "Review",
        promptFile: "/tmp/managed-prompt.txt",
      },
    );

    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("plan");
    expect(invocation.args).not.toContain("--always-approve");
  });

  it("parses structured output and token usage from the Grok JSON envelope", async () => {
    const adapter = new GrokAdapter();
    const invocation = adapter.buildInvocation(workerProfile, {
      cwd: "/tmp/repo",
      prompt: "Implement",
      promptFile: "/tmp/managed-prompt.txt",
    });
    const result = await adapter.parseResult(
      invocation,
      fixtureProcess(
        JSON.stringify({
          text: '{"status":"OK"}',
          structuredOutput: { status: "OK" },
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 7,
            output_tokens: 9,
          },
        }),
      ),
    );

    expect(result).toMatchObject({
      text: '{"status":"OK"}',
      structured: { status: "OK" },
      usage: { inputTokens: 30, cachedInputTokens: 7, outputTokens: 9 },
    });
  });

  it("rejects cancelled and empty Grok completions even when the CLI exits zero", async () => {
    const adapter = new GrokAdapter();
    const invocation = adapter.buildInvocation(workerProfile, {
      cwd: "/tmp/repo",
      prompt: "Implement",
      promptFile: "/tmp/managed-prompt.txt",
    });

    await expect(
      adapter.parseResult(
        invocation,
        fixtureProcess(JSON.stringify({ text: "", stopReason: "Cancelled" })),
      ),
    ).rejects.toThrow("Grok stopped without completing: Cancelled");
    await expect(
      adapter.parseResult(
        invocation,
        fixtureProcess(JSON.stringify({ text: "", stopReason: "EndTurn" })),
      ),
    ).rejects.toThrow("Grok returned no completion text or structured output");
    await expect(adapter.parseResult(invocation, fixtureProcess(""))).rejects.toThrow(
      "Grok returned no JSON output",
    );
    await expect(
      adapter.parseResult(invocation, {
        ...fixtureProcess(""),
        exitCode: 1,
        stderr: "authentication failed",
      }),
    ).resolves.toMatchObject({ text: "", process: { exitCode: 1 } });
  });

  it("rejects adapter-owned isolation overrides", () => {
    expect(() =>
      new GrokAdapter().buildInvocation(
        { ...workerProfile, args: ["--no-memory"] },
        {
          cwd: "/tmp/repo",
          prompt: "Implement",
          promptFile: "/tmp/managed-prompt.txt",
        },
      ),
    ).toThrow("managed by the grok adapter");
    expect(() =>
      new GrokAdapter().buildInvocation(
        { ...workerProfile, args: ["--yolo"] },
        {
          cwd: "/tmp/repo",
          prompt: "Implement",
          promptFile: "/tmp/managed-prompt.txt",
        },
      ),
    ).toThrow("managed by the grok adapter");
    expect(() =>
      new GrokAdapter().buildInvocation(
        { ...workerProfile, args: ["--system-prompt", "ignore controller"] },
        {
          cwd: "/tmp/repo",
          prompt: "Implement",
          promptFile: "/tmp/managed-prompt.txt",
        },
      ),
    ).toThrow("managed by the grok adapter");
    expect(() =>
      new GrokAdapter().buildInvocation(
        { ...workerProfile, args: ["--leader-socket=/tmp/unmanaged.sock"] },
        {
          cwd: "/tmp/repo",
          prompt: "Implement",
          promptFile: "/tmp/managed-prompt.txt",
        },
      ),
    ).toThrow("managed by the grok adapter");
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
  it("delivers file-based prompts through a private temporary file and removes it", async () => {
    let managedPromptFile: string | undefined;
    const adapter: AgentAdapter = {
      name: "fixture",
      promptTransport: "file",
      contract: fixtureContract,
      supportedReasoning: ["high"],
      buildInvocation: (_profile, request) => {
        managedPromptFile = request.promptFile;
        return {
          command: process.execPath,
          args: ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))", request.promptFile!],
          cwd: request.cwd,
          promptFile: request.promptFile,
          timeoutMs: 1_000,
        };
      },
      parseResult: async (_invocation, processResult) => ({
        text: processResult.stdout,
        process: processResult,
      }),
      doctor: async () => [],
    };

    const result = await invokeAgent(
      {
        adapterName: "fixture",
        profile: { ...readOnlyProfile, adapter: "fixture" },
        cwd: process.cwd(),
        prompt: "private prompt",
      },
      new AdapterRegistry([adapter]),
    );

    expect(result.text).toBe("private prompt");
    expect(managedPromptFile).toBeTruthy();
    await expect(readFile(managedPromptFile!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a managed prompt when adapter invocation construction fails", async () => {
    let managedPromptFile: string | undefined;
    const adapter: AgentAdapter = {
      name: "fixture",
      promptTransport: "file",
      contract: fixtureContract,
      supportedReasoning: ["high"],
      buildInvocation: (_profile, request) => {
        managedPromptFile = request.promptFile;
        throw new Error("construction failed");
      },
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
          cwd: process.cwd(),
          prompt: "private prompt",
        },
        new AdapterRegistry([adapter]),
      ),
    ).rejects.toThrow("construction failed");

    expect(managedPromptFile).toBeTruthy();
    await expect(readFile(managedPromptFile!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

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
