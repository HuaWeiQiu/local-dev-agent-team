import type { AgentProfile, Reasoning } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import {
  parseOutputFileResult,
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

  buildInvocation(profile: AgentProfile, request: AgentInvocationRequest): AgentInvocation {
    assertAdapterProfile(this, profile, request.outputSchema !== undefined);
    validateProfileArguments(profile, "codex");
    if (profile.externalTools === "deny" && profile.nativeProfile) {
      throw new Error("Codex nativeProfile requires externalTools: inherit");
    }
    if (!this.supportedReasoning.includes(profile.reasoning)) {
      throw new Error(`Codex adapter does not support reasoning '${profile.reasoning}'`);
    }

    const args = [
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

    if (profile.externalTools === "deny") {
      args.push(
        "--ignore-user-config",
        "-c",
        "project_root_markers=[]",
        "-c",
        `projects.${JSON.stringify(request.cwd)}.trust_level="untrusted"`,
      );
    }

    if (profile.nativeProfile) {
      args.push("--profile", profile.nativeProfile);
    }
    if (profile.model !== "inherit") {
      args.push("--model", profile.model);
    }
    if (request.outputSchema) {
      if (!request.outputFile) {
        throw new Error("Codex structured output requires an output file");
      }
      args.push("--output-schema", `${request.outputFile}.schema.json`);
      args.push("--output-last-message", request.outputFile);
    } else if (request.outputFile) {
      args.push("--output-last-message", request.outputFile);
    }

    args.push(...profile.args, "-");
    return {
      command: profile.executable ?? "codex",
      args,
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
