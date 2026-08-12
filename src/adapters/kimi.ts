import { homedir } from "node:os";
import path from "node:path";
import type { AgentProfile, Reasoning } from "../config/schema.js";
import { runProcess } from "../process/run.js";
import { assertAdapterProfile } from "./conformance.js";
import {
  parseKimiStreamJson,
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

const reasoning: readonly Reasoning[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Kimi Code CLI adapter (`kimi -p` non-interactive).
 * Uses stream-json output; structured results are extracted from assistant content
 * after the prompt embeds the JSON schema (CLI has no --json-schema flag).
 */
export class KimiAdapter implements AgentAdapter {
  readonly name = "kimi";
  readonly contract = {
    version: 1,
    transport: "local-process",
    permissions: ["read-only", "workspace-write"],
    externalTools: ["deny", "inherit"],
    structuredOutput: true,
    usage: [] as const,
  } as const;
  readonly supportedReasoning = reasoning;

  buildInvocation(profile: AgentProfile, request: AgentInvocationRequest): AgentInvocation {
    assertAdapterProfile(this, profile, request.outputSchema !== undefined);
    validateProfileArguments(profile, "kimi");

    let prompt = request.prompt;
    if (request.outputSchema) {
      prompt = `${prompt}

---
Return a single JSON object that validates against this JSON Schema.
Do not wrap it in markdown fences. Do not include commentary before or after the JSON.
JSON Schema:
${JSON.stringify(request.outputSchema)}
`;
    }
    if (profile.permission === "read-only") {
      prompt = `${prompt}

---
Operating constraint: READ-ONLY. Do not create, edit, delete, or overwrite any files.
Do not run shell commands that modify the workspace. Prefer read/search tools only.
`;
    }

    const args = [
      "--prompt",
      prompt,
      "--output-format",
      "stream-json",
    ];
    if (profile.model !== "inherit") {
      args.push("--model", profile.model);
    }
    // Note: kimi rejects combining -p with --yolo/--auto/--plan; rely on config
    // default_permission_mode and prompt constraints for permission behavior.
    args.push(...profile.args);

    return {
      command: profile.executable ?? "kimi",
      args,
      cwd: request.cwd,
      timeoutMs: profile.timeoutSeconds * 1_000,
      env: {
        ...process.env,
        // Keep Kimi home so provider keys resolve; do not rewrite HOME.
        KIMI_CODE_HOME: process.env.KIMI_CODE_HOME ?? path.join(homedir(), ".kimi-code"),
      },
    };
  }

  async parseResult(
    _invocation: AgentInvocation,
    process: Awaited<ReturnType<typeof runProcess>>,
  ): Promise<AgentRunResult> {
    return parseKimiStreamJson(process);
  }

  async doctor(options: AdapterDoctorOptions): Promise<DoctorCheck[]> {
    return await runAdapterDoctor(this, options, doctorSpec);
  }
}

const doctorSpec: AdapterDoctorSpec = {
  displayName: "Kimi",
  executableFallback: path.join(homedir(), ".kimi-code", "bin", "kimi"),
  authArgs: ["doctor"],
  authPassDetail: "Kimi Code configuration doctor completed",
  validateAuth: (result) => {
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || /not authenticated|login required|unauthorized/i.test(output)) {
      return { ok: false, detail: "Kimi Code is not authenticated or doctor failed" };
    }
    return { ok: true, detail: "Kimi Code configuration doctor completed" };
  },
  prepareProbeProfile: (profile) => profile,
};
