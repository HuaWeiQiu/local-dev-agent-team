import type { AgentProfile, Reasoning } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import { parseClaudeJson, validateProfileArguments } from "./shared.js";
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
    const executable = options.profile.executable ?? "claude";
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
      args: ["auth", "status"],
      cwd: options.cwd,
      timeoutMs: 10_000,
    });
    checks.push({
      profile: options.profileName,
      adapter: this.name,
      check: "authentication",
      status: auth.exitCode === 0 ? "pass" : "fail",
      detail: auth.exitCode === 0 ? "Claude authentication is available" : auth.stderr.trim(),
    });
    checks.push({
      profile: options.profileName,
      adapter: this.name,
      check: "capability",
      status: "pass",
      detail: `reasoning=${options.profile.reasoning}, permission=${options.profile.permission}, externalTools=${options.profile.externalTools}`,
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
    const profile: AgentProfile = {
      ...options.profile,
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
          ? `Model '${options.profile.model}' accepted by Claude`
          : result.stderr.trim() || "Claude model probe failed",
    };
  }
}
