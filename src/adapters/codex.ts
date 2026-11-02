import type { AgentProfile, Reasoning } from "../config/schema.js";
import { type runProcess } from "../process/run.js";
import {
  parseOutputFileResult,
  runAdapterDoctor,
  validateProfileArguments,
  type AdapterDoctorSpec,
} from "./shared.js";
import { assertAdapterProfile } from "./conformance.js";
import { CodexActivityParser } from "./codex-events.js";
import type {
  AdapterDoctorOptions,
  AgentAdapter,
  AgentInvocation,
  AgentInvocationRequest,
  AgentRunResult,
  DoctorCheck,
} from "./types.js";

const reasoning: readonly Reasoning[] = ["low", "medium", "high", "xhigh", "max"];

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly contract = {
    version: 1,
    transport: "local-process",
    permissions: ["read-only", "workspace-write"],
    externalTools: ["deny", "inherit"],
    structuredOutput: true,
    usage: ["inputTokens", "cachedInputTokens", "outputTokens"],
  } as const;
  readonly supportedReasoning = reasoning;

  createActivityParser(): CodexActivityParser {
    return new CodexActivityParser();
  }

  buildInvocation(profile: AgentProfile, request: AgentInvocationRequest): AgentInvocation {
    assertAdapterProfile(this, profile, request.outputSchema !== undefined);
    validateProfileArguments(profile, "codex");
    assertExternalToolPolicy(profile);
    return {
      command: profile.executable ?? "codex",
      args: codexArgs(profile, request),
      cwd: request.cwd,
      stdin: request.prompt,
      timeoutMs: profile.timeoutSeconds * 1_000,
      ...(request.outputFile ? { outputFile: request.outputFile } : {}),
    };
  }

  async parseResult(invocation: AgentInvocation, process: Awaited<ReturnType<typeof runProcess>>): Promise<AgentRunResult> {
    return await parseOutputFileResult(invocation, process);
  }

  async doctor(options: AdapterDoctorOptions): Promise<DoctorCheck[]> {
    return await runAdapterDoctor(this, options, doctorSpec);
  }
}

/** A native profile pulls in user configuration, which the deny policy forbids. */
function assertExternalToolPolicy(profile: AgentProfile): void {
  if (profile.externalTools !== "deny" || !profile.nativeProfile) return;
  throw new Error("Codex nativeProfile requires externalTools: inherit");
}

function baseArgs(profile: AgentProfile, request: AgentInvocationRequest): string[] {
  return [
    "exec",
    "--ephemeral",
    "--color",
    "never",
    "--json",
    "--sandbox",
    profile.permission,
    "-C",
    request.cwd,
    "-c",
    `model_reasoning_effort="${profile.reasoning}"`,
  ];
}

/** Denied external tools isolate the child from the user's own Codex config. */
function isolationArgs(profile: AgentProfile, request: AgentInvocationRequest): string[] {
  if (profile.externalTools !== "deny") return [];
  return [
    "--ignore-user-config",
    "-c",
    "project_root_markers=[]",
    "-c",
    `projects.${JSON.stringify(request.cwd)}.trust_level="untrusted"`,
  ];
}

function providerArgs(profile: AgentProfile): string[] {
  return profile.codexProvider ? codexProviderArguments(profile.codexProvider) : [];
}

function identityArgs(profile: AgentProfile): string[] {
  const args: string[] = [];
  if (profile.nativeProfile) args.push("--profile", profile.nativeProfile);
  if (profile.model !== "inherit") args.push("--model", profile.model);
  return args;
}

/** Structured output needs a file to write the schema and the last message to. */
function outputArgs(request: AgentInvocationRequest): string[] {
  if (request.outputSchema) {
    if (!request.outputFile) throw new Error("Codex structured output requires an output file");
    return [
      "--output-schema",
      `${request.outputFile}.schema.json`,
      "--output-last-message",
      request.outputFile,
    ];
  }
  return request.outputFile ? ["--output-last-message", request.outputFile] : [];
}

function codexArgs(profile: AgentProfile, request: AgentInvocationRequest): string[] {
  return [
    ...baseArgs(profile, request),
    ...isolationArgs(profile, request),
    ...providerArgs(profile),
    ...identityArgs(profile),
    ...outputArgs(request),
    ...profile.args,
    "-",
  ];
}

const doctorSpec: AdapterDoctorSpec = {
  displayName: "Codex",
  executableFallback: "codex",
  authArgs: ["login", "status"],
  authPassDetail: "Codex authentication is available",
  prepareProbeProfile: (profile) => {
    // Native profiles pull in user-level configuration the probe must not use.
    const { nativeProfile: _nativeProfile, ...probeProfile } = profile;
    return probeProfile;
  },
};

export function codexProviderArguments(
  provider: NonNullable<AgentProfile["codexProvider"]>,
): string[] {
  const prefix = `model_providers.${provider.id}`;
  return [
    "-c",
    `model_provider=${JSON.stringify(provider.id)}`,
    "-c",
    `${prefix}.name=${JSON.stringify(provider.name ?? provider.id)}`,
    "-c",
    `${prefix}.base_url=${JSON.stringify(provider.baseUrl)}`,
    "-c",
    `${prefix}.wire_api=${JSON.stringify(provider.wireApi)}`,
    "-c",
    `${prefix}.requires_openai_auth=${provider.requiresOpenAIAuth}`,
    "-c",
    `${prefix}.supports_websockets=${provider.supportsWebSockets}`,
  ];
}
