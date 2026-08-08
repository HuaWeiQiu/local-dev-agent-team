import type { AgentProfile, Reasoning } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import { parseOutputFileResult, validateProfileArguments } from "./shared.js";
import { assertAdapterProfile } from "./conformance.js";
import type {
  AdapterDoctorOptions,
  AgentAdapter,
  AgentInvocation,
  AgentInvocationRequest,
  AgentRunResult,
  DoctorCheck,
} from "./types.js";

const reasoning: readonly Reasoning[] = ["low", "medium", "high", "xhigh"];

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
    const executable = options.profile.executable ?? "codex";
    const checks: DoctorCheck[] = [];
    const version = await runProcess({
      command: executable,
      args: ["--version"],
      cwd: options.cwd,
      timeoutMs: 10_000,
    }).catch(() => undefined);
    checks.push({
      profile: options.profileName,
      adapter: this.name,
      check: "executable",
      status: version?.exitCode === 0 ? "pass" : "fail",
      detail: version?.stdout.trim() || version?.stderr.trim() || `${executable} not found`,
    });
    if (version?.exitCode !== 0) {
      return checks;
    }

    const auth = await runProcess({
      command: executable,
      args: ["login", "status"],
      cwd: options.cwd,
      timeoutMs: 10_000,
    });
    checks.push({
      profile: options.profileName,
      adapter: this.name,
      check: "authentication",
      status: auth.exitCode === 0 ? "pass" : "fail",
      detail: auth.exitCode === 0 ? "Codex authentication is available" : auth.stderr.trim(),
    });

    const capabilityOk = this.supportedReasoning.includes(options.profile.reasoning);
    checks.push({
      profile: options.profileName,
      adapter: this.name,
      check: "capability",
      status: capabilityOk ? "pass" : "fail",
      detail: capabilityOk
        ? `reasoning=${options.profile.reasoning}, permission=${options.profile.permission}, externalTools=${options.profile.externalTools}`
        : `Unsupported reasoning '${options.profile.reasoning}'`,
    });

    checks.push(
      options.probeModel
        ? await this.probeModel(options)
        : {
            profile: options.profileName,
            adapter: this.name,
            check: "model",
            status: "skip",
            detail: "Active model probe not requested",
          },
    );
    return checks;
  }

  private async probeModel(options: AdapterDoctorOptions): Promise<DoctorCheck> {
    const { nativeProfile: _nativeProfile, ...probeProfile } = options.profile;
    const profile: AgentProfile = {
      ...probeProfile,
      permission: "read-only",
      externalTools: "deny",
      timeoutSeconds: Math.min(options.profile.timeoutSeconds, 120),
      args: [],
    };
    const invocation = this.buildInvocation(profile, {
      cwd: options.cwd,
      prompt: "Reply with exactly OK. Do not call tools.",
    });
    const result = await runProcess(invocation);
    return {
      profile: options.profileName,
      adapter: this.name,
      check: "model",
      status: result.exitCode === 0 ? "pass" : "fail",
      detail:
        result.exitCode === 0
          ? `Model '${options.profile.model}' accepted by Codex`
          : result.stderr.trim() || "Codex model probe failed",
    };
  }
}
