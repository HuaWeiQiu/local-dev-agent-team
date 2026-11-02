import { homedir } from "node:os";
import path from "node:path";
import type { AgentProfile, Reasoning } from "../config/schema.js";
import { type runProcess } from "../process/run.js";
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
    return {
      command: profile.executable ?? "grok",
      args: grokArgs(profile, request, request.promptFile),
      cwd: request.cwd,
      promptFile: request.promptFile,
      env: grokEnv(profile, request.promptFile),
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

function baseArgs(profile: AgentProfile, request: AgentInvocationRequest): string[] {
  return [
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
}

/** The tool policy the profile was granted, expressed as grok flags. */
function toolArgs(profile: AgentProfile): string[] {
  if (profile.permission === "read-only") {
    return ["--permission-mode", "plan", "--tools", readOnlyTools];
  }
  return ["--always-approve", "--tools", workerTools];
}

function isolationArgs(profile: AgentProfile): string[] {
  if (profile.externalTools !== "deny") return [];
  return ["--disallowed-tools", deniedTools, "--deny", "MCPTool(*)"];
}

function modelArgs(profile: AgentProfile): string[] {
  const model = resolveGrokModelId(profile.model);
  return model ? ["--model", model] : [];
}

function schemaArgs(request: AgentInvocationRequest): string[] {
  return request.outputSchema ? ["--json-schema", JSON.stringify(request.outputSchema)] : [];
}

function grokArgs(
  profile: AgentProfile,
  request: AgentInvocationRequest,
  promptFile: string,
): string[] {
  return [
    ...baseArgs(profile, request),
    ...toolArgs(profile),
    ...isolationArgs(profile),
    ...modelArgs(profile),
    ...schemaArgs(request),
    ...profile.args,
    "--prompt-file",
    promptFile,
  ];
}

/** A denied tool policy also fences the homes so the child cannot reach global MCP config. */
function grokEnv(profile: AgentProfile, promptFile: string): NodeJS.ProcessEnv {
  const sanitized = sanitizedChildEnv();
  if (profile.externalTools !== "deny") return sanitized;
  return {
    ...sanitized,
    HOME: path.dirname(promptFile),
    USERPROFILE: path.dirname(promptFile),
    GROK_HOME: process.env.GROK_HOME ?? path.join(homedir(), ".grok"),
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
  };
}

/**
 * `grok` is the CLI name, not a model id. Bare `grok` / `inherit` must not be
 * forwarded as `--model grok`, or they override the user's Grok CLI default
 * (currently grok-4.6) and hit a 503 alias.
 */
export function resolveGrokModelId(model: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value || value === "inherit" || value === "grok") {
    return undefined;
  }
  return value;
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
