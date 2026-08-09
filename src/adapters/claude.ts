import type { AgentProfile, Reasoning } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import {
  parseClaudeJson,
  runAdapterDoctor,
  validateProfileArguments,
  type AdapterDoctorSpec,
} from "./shared.js";
import { assertAdapterProfile } from "./conformance.js";
import type {
  AdapterDoctorOptions,
  AgentAdapter,
  AgentInvocation,
  AgentInvocationRequest,
  AgentRunResult,
  DoctorCheck,
} from "./types.js";

const reasoning: readonly Reasoning[] = ["low", "medium", "high", "xhigh", "max"];

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude";
  readonly contract = {
    version: 1,
    transport: "local-process",
    permissions: ["read-only", "workspace-write"],
    externalTools: ["deny", "inherit"],
    structuredOutput: true,
    usage: ["inputTokens", "cachedInputTokens", "outputTokens", "reportedCostUsd"],
  } as const;
  readonly supportedReasoning = reasoning;

  buildInvocation(profile: AgentProfile, request: AgentInvocationRequest): AgentInvocation {
    assertAdapterProfile(this, profile, request.outputSchema !== undefined);
    validateProfileArguments(profile, "claude");
    const permissionMode = profile.permission === "read-only" ? "plan" : "acceptEdits";
    const args = [
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--permission-mode",
      permissionMode,
      "--effort",
      profile.reasoning,
    ];
    if (profile.permission === "read-only") {
      args.push("--tools", "Read,Glob,Grep");
      args.push("--disallowed-tools", "Edit,Write,NotebookEdit,Bash");
    }
    if (profile.model !== "inherit") {
      args.push("--model", profile.model);
    }
    if (profile.externalTools === "deny") {
      args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    }
    if (request.outputSchema) {
      args.push("--json-schema", JSON.stringify(request.outputSchema));
    }
    args.push(...profile.args);

    return {
      command: profile.executable ?? "claude",
      args,
      cwd: request.cwd,
      stdin: request.prompt,
      timeoutMs: profile.timeoutSeconds * 1_000,
    };
  }

  async parseResult(_invocation: AgentInvocation, process: Awaited<ReturnType<typeof runProcess>>): Promise<AgentRunResult> {
    return parseClaudeJson(process);
  }

  async doctor(options: AdapterDoctorOptions): Promise<DoctorCheck[]> {
    return await runAdapterDoctor(this, options, doctorSpec);
  }
}

const doctorSpec: AdapterDoctorSpec = {
  displayName: "Claude",
  executableFallback: "claude",
  authArgs: ["auth", "status"],
  authPassDetail: "Claude authentication is available",
  prepareProbeProfile: (profile) => profile,
};
