import { readFile } from "node:fs/promises";
import type {
  AdapterDoctorOptions,
  AgentAdapter,
  AgentInvocation,
  AgentRunResult,
  DoctorCheck,
} from "./types.js";
import type { AgentProfile } from "../config/schema.js";
import { runProcess, type ProcessResult } from "../process/run.js";
import type { AgentUsage } from "./types.js";

const reservedArguments = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-skip-permissions",
  "--sandbox",
  "-s",
  "--permission-mode",
  "--model",
  "-m",
  "--cd",
  "-C",
  "--output-schema",
  "--json-schema",
  "--output-last-message",
  "-o",
  "--profile",
  "-p",
  "--config",
  "-c",
  "--add-dir",
  "--mcp-config",
  "--strict-mcp-config",
  "--tools",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--setting-sources",
  "--settings",
  "--plugin-dir",
  "--plugin-url",
  "--fallback-model",
  "--resume",
  "-r",
  "--continue",
  "--worktree",
  "-w",
  "--ignore-rules",
  "--ignore-user-config",
  "--approve-for-me",
  "--dangerously-bypass-hook-trust",
  "--oss",
  "--local-provider",
  "--enable",
  "--disable",
  "--json",
  "--color",
  "--ephemeral",
  "--strict-config",
  "--skip-git-repo-check",
  "--image",
  "-i",
  "--print",
  "--output-format",
  "--input-format",
  "--no-session-persistence",
  "--effort",
  "--fork-session",
  "--session-id",
  "--background",
  "--bg",
  "--remote-control",
  "--tmux",
  "--from-pr",
  "--file",
  "--chrome",
  "--allow-dangerously-skip-permissions",
]);

const attachedShortArguments = ["-c", "-C", "-m", "-o", "-p", "-r", "-s", "-w"];

export function validateProfileArguments(
  profile: AgentProfile,
  adapterName: string,
): void {
  for (const argument of profile.args) {
    const key = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    const attached = attachedShortArguments.find(
      (flag) => argument.startsWith(flag) && argument !== flag,
    );
    if (reservedArguments.has(key) || attached) {
      throw new Error(
        `Profile argument '${attached ?? key}' is managed by the ${adapterName} adapter and cannot be overridden`,
      );
    }
  }
}

/**
 * Per-adapter parameters for the shared doctor sequence: executable discovery,
 * authentication probe, and the optional live model probe.
 */
export interface AdapterDoctorSpec {
  displayName: string;
  executableFallback: string;
  authArgs: string[];
  authPassDetail: string;
  prepareProbeProfile: (profile: AgentProfile) => AgentProfile;
}

/**
 * Shared doctor sequence for CLI adapters: version probe, authentication probe,
 * capability check against the adapter's supported reasoning, and an optional
 * model probe. Check order, statuses, and detail strings are adapter-neutral.
 */
export async function runAdapterDoctor(
  adapter: AgentAdapter,
  options: AdapterDoctorOptions,
  spec: AdapterDoctorSpec,
): Promise<DoctorCheck[]> {
  const executable = options.profile.executable ?? spec.executableFallback;
  const checks: DoctorCheck[] = [];
  const version = await runProcess({
    command: executable,
    args: ["--version"],
    cwd: options.cwd,
    timeoutMs: 10_000,
  }).catch(() => undefined);
  checks.push({
    profile: options.profileName,
    adapter: adapter.name,
    check: "executable",
    status: version?.exitCode === 0 ? "pass" : "fail",
    detail: version?.stdout.trim() || version?.stderr.trim() || `${executable} not found`,
  });
  if (version?.exitCode !== 0) {
    return checks;
  }

  const auth = await runProcess({
    command: executable,
    args: spec.authArgs,
    cwd: options.cwd,
    timeoutMs: 10_000,
  });
  checks.push({
    profile: options.profileName,
    adapter: adapter.name,
    check: "authentication",
    status: auth.exitCode === 0 ? "pass" : "fail",
    detail: auth.exitCode === 0 ? spec.authPassDetail : auth.stderr.trim(),
  });

  const capabilityOk = adapter.supportedReasoning.includes(options.profile.reasoning);
  checks.push({
    profile: options.profileName,
    adapter: adapter.name,
    check: "capability",
    status: capabilityOk ? "pass" : "fail",
    detail: capabilityOk
      ? `reasoning=${options.profile.reasoning}, permission=${options.profile.permission}, externalTools=${options.profile.externalTools}`
      : `Unsupported reasoning '${options.profile.reasoning}'`,
  });

  checks.push(
    options.probeModel
      ? await probeAdapterModel(adapter, options, spec)
      : {
          profile: options.profileName,
          adapter: adapter.name,
          check: "model",
          status: "skip",
          detail: "Active model probe not requested",
        },
  );
  return checks;
}

async function probeAdapterModel(
  adapter: AgentAdapter,
  options: AdapterDoctorOptions,
  spec: AdapterDoctorSpec,
): Promise<DoctorCheck> {
  const profile: AgentProfile = {
    ...spec.prepareProbeProfile(options.profile),
    permission: "read-only",
    externalTools: "deny",
    timeoutSeconds: Math.min(options.profile.timeoutSeconds, 120),
    args: [],
  };
  const invocation = adapter.buildInvocation(profile, {
    cwd: options.cwd,
    prompt: "Reply with exactly OK. Do not call tools.",
  });
  const result = await runProcess(invocation);
  return {
    profile: options.profileName,
    adapter: adapter.name,
    check: "model",
    status: result.exitCode === 0 ? "pass" : "fail",
    detail:
      result.exitCode === 0
        ? `Model '${options.profile.model}' accepted by ${spec.displayName}`
        : result.stderr.trim() || `${spec.displayName} model probe failed`,
  };
}

export async function parseOutputFileResult(
  invocation: AgentInvocation,
  process: ProcessResult,
): Promise<AgentRunResult> {
  let text = process.stdout.trim();
  if (invocation.outputFile) {
    try {
      text = (await readFile(invocation.outputFile, "utf8")).trim();
    } catch {
      // The process error below carries the actionable failure details.
    }
  }

  let structured: unknown;
  if (text) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = undefined;
    }
  }

  const usage = extractCodexUsage(process.stdout);
  return structured === undefined
    ? { text, process, ...(usage ? { usage } : {}) }
    : { text, structured, process, ...(usage ? { usage } : {}) };
}

export function parseClaudeJson(process: ProcessResult): AgentRunResult {
  const text = process.stdout.trim();
  if (!text) {
    return { text: "", process };
  }
  try {
    const envelope = JSON.parse(text) as Record<string, unknown>;
    const structured = envelope.structured_output ?? envelope.structuredOutput;
    const result = typeof envelope.result === "string" ? envelope.result : text;
    const usage = extractUsage(envelope);
    return structured === undefined
      ? { text: result, process, ...(usage ? { usage } : {}) }
      : { text: result, structured, process, ...(usage ? { usage } : {}) };
  } catch {
    return { text, process };
  }
}

function extractCodexUsage(stdout: string): AgentUsage | undefined {
  let usage: AgentUsage | undefined;
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      usage = extractUsage(event) ?? usage;
    } catch {
      // Codex JSONL may be mixed with non-event diagnostics.
    }
  }
  return usage;
}

function extractUsage(envelope: Record<string, unknown>): AgentUsage | undefined {
  const raw = isRecord(envelope.usage) ? envelope.usage : undefined;
  const inputTokens = numberField(raw, "input_tokens", "inputTokens");
  const cachedInputTokens = numberField(raw, "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens");
  const outputTokens = numberField(raw, "output_tokens", "outputTokens");
  const reportedCostUsd = numberField(envelope, "total_cost_usd", "totalCostUsd");
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reportedCostUsd === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
  };
}

function numberField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
