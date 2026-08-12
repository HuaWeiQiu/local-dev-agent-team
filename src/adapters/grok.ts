import { homedir } from "node:os";
import path from "node:path";
import type { AgentProfile, Reasoning } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import { sanitizedChildEnv } from "../process/env.js";
import { assertAdapterProfile } from "./conformance.js";
import {
  parseGrokJson,
  runAdapterDoctor,
  validateProfileArguments,
  type AdapterDoctorSpec,
} from "./shared.js";
import type {
  AdapterDoctorOptions,
  AgentAdapter,
  AgentInvocation,
  AgentInvocationRequest,
  AgentRunResult,
  DoctorCheck,
} from "./types.js";

const reasoning: readonly Reasoning[] = ["low", "medium", "high"];
const readOnlyTools = "read_file,grep,list_dir";
const workerTools = "read_file,grep,list_dir,search_replace,run_terminal_cmd";
const deniedTools = [
  "search_tool",
  "use_tool",
  "fetch_mcp_resource",
  "list_mcp_resources",
  "web_search",
  "web_fetch",
  "memory_search",
  "Agent",
].join(",");

export class GrokAdapter implements AgentAdapter {
  readonly name = "grok";
  readonly promptTransport = "file" as const;
  readonly contract = {
    version: 1,
    transport: "local-process",
    permissions: ["read-only", "workspace-write"],
    externalTools: ["deny", "inherit"],
    structuredOutput: true,
    usage: ["inputTokens", "cachedInputTokens", "outputTokens"],
  } as const;
  readonly supportedReasoning = reasoning;

  buildInvocation(profile: AgentProfile, request: AgentInvocationRequest): AgentInvocation {
    assertAdapterProfile(this, profile, request.outputSchema !== undefined);
    validateProfileArguments(profile, "grok");
    if (!request.promptFile) {
      throw new Error("Grok headless mode requires a managed prompt file");
    }

    const args = [
      "--cwd",
      request.cwd,
      "--output-format",
      "json",
      "--reasoning-effort",
      profile.reasoning,
      "--sandbox",
      profile.permission === "read-only" ? "read-only" : "workspace",
      "--no-memory",
      "--no-subagents",
      "--disable-web-search",
      "--no-auto-update",
      "--max-turns",
      String(profile.maxTurns ?? 24),
    ];

    if (profile.permission === "read-only") {
      args.push("--permission-mode", "plan", "--tools", readOnlyTools);
    } else {
      args.push("--always-approve", "--tools", workerTools);
    }
    if (profile.externalTools === "deny") {
      args.push("--disallowed-tools", deniedTools, "--deny", "MCPTool(*)");
    }
    if (profile.model !== "inherit") {
      args.push("--model", profile.model);
    }
    if (request.outputSchema) {
      args.push("--json-schema", JSON.stringify(request.outputSchema));
    }
    args.push(...profile.args, "--prompt-file", request.promptFile);

    return {
      command: profile.executable ?? "grok",
      args,
      cwd: request.cwd,
      promptFile: request.promptFile,
      env:
        profile.externalTools === "deny"
          ? {
              ...sanitizedChildEnv(),
              HOME: path.dirname(request.promptFile),
              USERPROFILE: path.dirname(request.promptFile),
              GROK_HOME: process.env.GROK_HOME ?? path.join(homedir(), ".grok"),
              GROK_CLAUDE_MCPS_ENABLED: "false",
              GROK_CURSOR_MCPS_ENABLED: "false",
            }
          : sanitizedChildEnv(),
      timeoutMs: profile.timeoutSeconds * 1_000,
    };
  }

  async parseResult(
    _invocation: AgentInvocation,
    process: Awaited<ReturnType<typeof runProcess>>,
  ): Promise<AgentRunResult> {
    return parseGrokJson(process);
  }

  async doctor(options: AdapterDoctorOptions): Promise<DoctorCheck[]> {
    return await runAdapterDoctor(this, options, doctorSpec);
  }
}

const doctorSpec: AdapterDoctorSpec = {
  displayName: "Grok",
  executableFallback: "grok",
  authArgs: ["models"],
  authPassDetail: "Grok authentication and model discovery are available",
  validateAuth: (result) => {
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || /not authenticated/i.test(output)) {
      return { ok: false, detail: "Grok is not authenticated" };
    }
    return { ok: true, detail: "Grok authentication and model discovery are available" };
  },
  prepareProbeProfile: (profile) => profile,
};
