import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  "--always-approve",
  "--yolo",
  "--allow",
  "--deny",
  "--model",
  "-m",
  "--cd",
  "--cwd",
  "-C",
  "--output-schema",
  "--json-schema",
  "--single",
  "--prompt-file",
  "--prompt-json",
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
  "--max-turns",
  "--disable-web-search",
  "--no-auto-update",
  "--no-memory",
  "--experimental-memory",
  "--no-subagents",
  "--no-plan",
  "--no-ask-user",
  "--agent",
  "--agents",
  "--rules",
  "--append-system-prompt",
  "--system-prompt-override",
  "--system-prompt",
  "--verbatim",
  "--setting-sources",
  "--settings",
  "--plugin-dir",
  "--plugin-url",
  "--agent-profile",
  "--leader",
  "--no-leader",
  "--leader-socket",
  "--reauth",
  "--oauth",
  "--debug",
  "--debug-file",
  "--grok-ws-origin",
  "--grok-ws-url",
  "--cli-chat-proxy-base-url",
  "--xai-api-base-url",
  "--client-identifier",
  "--fallback-model",
  "--resume",
  "-r",
  "--continue",
  "--worktree",
  "-w",
  "--worktree-ref",
  "--restore-code",
  "--trust-folder",
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
  "--prompt",
  "--output-format",
  "--skills-dir",
  "--strict-config",
  "--skip-git-repo-check",
  "--image",
  "-i",
  "--print",
  "--output-format",
  "--input-format",
  "--no-session-persistence",
  "--effort",
  "--reasoning-effort",
  "--fork-session",
  "--session-id",
  "--background",
  "--bg",
  "--no-wait-for-background",
  "--background-wait-timeout",
  "--storage-mode",
  "--todo-gate",
  "--hunk-tracker-mode",
  "--fs-read",
  "--fs-write",
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
  validateAuth?: (result: ProcessResult) => { ok: boolean; detail: string };
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
  const version = await probeVersion(executable, options);
  const checks: DoctorCheck[] = [executableCheck(adapter, options, executable, version)];
  if (version?.exitCode !== 0) return checks;
  checks.push(await authCheck(adapter, options, spec, executable));
  checks.push(capabilityCheck(adapter, options));
  checks.push(await modelCheck(adapter, options, spec));
  return checks;
}

async function probeVersion(
  executable: string,
  options: AdapterDoctorOptions,
): Promise<ProcessResult | undefined> {
  return runProcess({
    command: executable,
    args: ["--version"],
    cwd: options.cwd,
    timeoutMs: 10_000,
  }).catch(() => undefined);
}

function executableCheck(
  adapter: AgentAdapter,
  options: AdapterDoctorOptions,
  executable: string,
  version: ProcessResult | undefined,
): DoctorCheck {
  return {
    profile: options.profileName,
    adapter: adapter.name,
    check: "executable",
    status: version?.exitCode === 0 ? "pass" : "fail",
    detail: version?.stdout.trim() || version?.stderr.trim() || `${executable} not found`,
  };
}

async function authCheck(
  adapter: AgentAdapter,
  options: AdapterDoctorOptions,
  spec: AdapterDoctorSpec,
  executable: string,
): Promise<DoctorCheck> {
  const auth = await runProcess({
    command: executable,
    args: spec.authArgs,
    cwd: options.cwd,
    timeoutMs: 10_000,
  });
  const validation = spec.validateAuth?.(auth) ?? defaultAuthValidation(auth, spec);
  return {
    profile: options.profileName,
    adapter: adapter.name,
    check: "authentication",
    status: validation.ok ? "pass" : "fail",
    detail: validation.detail,
  };
}

function defaultAuthValidation(
  auth: ProcessResult,
  spec: AdapterDoctorSpec,
): { ok: boolean; detail: string } {
  if (auth.exitCode === 0) return { ok: true, detail: spec.authPassDetail };
  return { ok: false, detail: auth.stderr.trim() };
}

function capabilityCheck(adapter: AgentAdapter, options: AdapterDoctorOptions): DoctorCheck {
  const ok = adapter.supportedReasoning.includes(options.profile.reasoning);
  return {
    profile: options.profileName,
    adapter: adapter.name,
    check: "capability",
    status: ok ? "pass" : "fail",
    detail: ok ? capabilityDetail(options.profile) : `Unsupported reasoning '${options.profile.reasoning}'`,
  };
}

function capabilityDetail(profile: AgentProfile): string {
  return `reasoning=${profile.reasoning}, permission=${profile.permission}, externalTools=${profile.externalTools}`;
}

async function modelCheck(
  adapter: AgentAdapter,
  options: AdapterDoctorOptions,
  spec: AdapterDoctorSpec,
): Promise<DoctorCheck> {
  if (!options.probeModel) {
    return {
      profile: options.profileName,
      adapter: adapter.name,
      check: "model",
      status: "skip",
      detail: "Active model probe not requested",
    };
  }
  return probeAdapterModel(adapter, options, spec);
}

async function probeAdapterModel(
  adapter: AgentAdapter,
  options: AdapterDoctorOptions,
  spec: AdapterDoctorSpec,
): Promise<DoctorCheck> {
  const profile = probeProfile(options.profile, spec);
  const prompt = "Reply with exactly OK. Do not call tools.";
  const promptDirectory = await makePromptDirectory(adapter);
  const promptFile = promptDirectory ? path.join(promptDirectory, "prompt.txt") : undefined;
  try {
    if (promptFile) await writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600 });
    const outcome = await runProbe(adapter, { profile, prompt, cwd: options.cwd, promptFile });
    return probeResult(adapter, options, spec, outcome);
  } finally {
    if (promptDirectory) await rm(promptDirectory, { recursive: true, force: true });
  }
}

function probeProfile(profile: AgentProfile, spec: AdapterDoctorSpec): AgentProfile {
  return {
    ...spec.prepareProbeProfile(profile),
    permission: "read-only",
    externalTools: "deny",
    timeoutSeconds: Math.min(profile.timeoutSeconds, 120),
    args: [],
  };
}

async function makePromptDirectory(adapter: AgentAdapter): Promise<string | undefined> {
  if (adapter.promptTransport !== "file") return undefined;
  return mkdtemp(path.join(tmpdir(), "agent-team-doctor-prompt-"));
}

interface ProbeOutcome {
  result: ProcessResult;
  parseError: unknown;
}

async function runProbe(
  adapter: AgentAdapter,
  input: {
    profile: AgentProfile;
    prompt: string;
    cwd: string;
    promptFile: string | undefined;
  },
): Promise<ProbeOutcome> {
  const invocation = adapter.buildInvocation(input.profile, {
    cwd: input.cwd,
    prompt: input.prompt,
    ...(input.promptFile ? { promptFile: input.promptFile } : {}),
  });
  const result = await runProcess(invocation);
  if (result.exitCode !== 0) return { result, parseError: undefined };
  try {
    await adapter.parseResult(invocation, result);
    return { result, parseError: undefined };
  } catch (error) {
    return { result, parseError: error };
  }
}

function probeResult(
  adapter: AgentAdapter,
  options: AdapterDoctorOptions,
  spec: AdapterDoctorSpec,
  outcome: ProbeOutcome,
): DoctorCheck {
  const passed = outcome.result.exitCode === 0 && outcome.parseError === undefined;
  return {
    profile: options.profileName,
    adapter: adapter.name,
    check: "model",
    status: passed ? "pass" : "fail",
    detail: probeDetail(options, spec, outcome, passed),
  };
}

function probeDetail(
  options: AdapterDoctorOptions,
  spec: AdapterDoctorSpec,
  outcome: ProbeOutcome,
  passed: boolean,
): string {
  if (passed) return `Model '${options.profile.model}' accepted by ${spec.displayName}`;
  if (outcome.parseError) {
    return `${spec.displayName} model probe returned invalid output: ${errorMessage(outcome.parseError)}`;
  }
  return outcome.result.stderr.trim() || `${spec.displayName} model probe failed`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function parseOutputFileResult(
  invocation: AgentInvocation,
  process: ProcessResult,
): Promise<AgentRunResult> {
  const text = await outputText(invocation, process);
  return runResult(text, tryParseJson(text), extractCodexUsage(process.stdout), process);
}

/** The output file wins when the adapter writes one; otherwise stdout. */
async function outputText(invocation: AgentInvocation, process: ProcessResult): Promise<string> {
  if (!invocation.outputFile) return process.stdout.trim();
  try {
    return (await readFile(invocation.outputFile, "utf8")).trim();
  } catch {
    // The process error below carries the actionable failure details.
    return process.stdout.trim();
  }
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Structured output only when parsing produced one; usage only when reported. */
function runResult(
  text: string,
  structured: unknown,
  usage: AgentUsage | undefined,
  process: ProcessResult,
): AgentRunResult {
  return {
    text,
    ...(structured === undefined ? {} : { structured }),
    process,
    ...(usage ? { usage } : {}),
  };
}

export function parseClaudeJson(process: ProcessResult): AgentRunResult {
  const text = process.stdout.trim();
  if (!text) return { text: "", process };
  const envelope = asRecord(tryParseJson(text));
  if (!envelope) return { text, process };
  const structured = envelope.structured_output ?? envelope.structuredOutput;
  const result = typeof envelope.result === "string" ? envelope.result : text;
  return runResult(result, structured, extractUsage(envelope), process);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse Kimi Code CLI `--output-format stream-json` stdout.
 * Lines are NDJSON with role/type/content fields; assistant content is concatenated.
 */
export function parseKimiStreamJson(process: ProcessResult): AgentRunResult {
  const raw = process.stdout.trim();
  if (!raw) {
    if (process.exitCode !== 0) return { text: "", process };
    throw new Error("Kimi returned no stream-json output");
  }
  const text = assistantText(raw);
  return runResult(text, structuredFromText(text), undefined, process);
}

/** Assistant chunks across NDJSON lines; the raw stream when nothing parsed. */
function assistantText(raw: string): string {
  const chunks = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => assistantChunk(line))
    .filter((chunk): chunk is string => chunk !== undefined);
  return chunks.join("").trim() || raw;
}

function assistantChunk(line: string): string | undefined {
  const event = asRecord(tryParseJson(line));
  if (!event) return undefined;
  if (event.role === "assistant" && typeof event.content === "string") return event.content;
  if (event.type === "assistant" && typeof event.content === "string") return event.content;
  if (typeof event.text === "string" && event.role !== "meta") return event.text;
  return undefined;
}

/** Plain JSON, else a fenced block, else the trailing object. */
function structuredFromText(text: string): unknown {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() ?? extractTrailingJsonObject(text);
  return candidate ? tryParseJson(candidate) : undefined;
}

function extractTrailingJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function isGrokCompletedStop(stopReason: string): boolean {
  return stopReason.replace(/[_-]/g, "").toLowerCase() === "endturn";
}

export function parseGrokJson(process: ProcessResult): AgentRunResult {
  const rawText = process.stdout.trim();
  if (!rawText) return emptyGrokResult(process);
  const envelope = parseGrokEnvelope(rawText, process);
  if (!envelope) return { text: rawText, process };
  const structured = envelope.structuredOutput ?? envelope.structured_output;
  const text = typeof envelope.text === "string" ? envelope.text : rawText;
  assertGrokCompleted(envelope, text, structured);
  return runResult(text, structured, extractUsage(envelope), process);
}

function emptyGrokResult(process: ProcessResult): AgentRunResult {
  if (process.exitCode !== 0) return { text: "", process };
  throw new Error("Grok returned no JSON output");
}

function parseGrokEnvelope(
  rawText: string,
  process: ProcessResult,
): Record<string, unknown> | undefined {
  try {
    return JSON.parse(rawText) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // A failing process may still print prose; only a clean exit must be JSON.
    if (process.exitCode !== 0) return undefined;
    throw new Error("Grok returned invalid JSON output", { cause: error });
  }
}

/** A stop reason other than completion, or an empty body, is a failure. */
function assertGrokCompleted(
  envelope: Record<string, unknown>,
  text: string,
  structured: unknown,
): void {
  const stopReason = typeof envelope.stopReason === "string" ? envelope.stopReason : undefined;
  if (stopReason && !isGrokCompletedStop(stopReason)) {
    throw new Error(`Grok stopped without completing: ${stopReason}`);
  }
  if (!text && structured === undefined) {
    throw new Error("Grok returned no completion text or structured output");
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

export function extractUsage(envelope: Record<string, unknown>): AgentUsage | undefined {
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
  return compactUsage({ inputTokens, cachedInputTokens, outputTokens, reportedCostUsd });
}

/** Drop the counters the provider did not report. */
function compactUsage(input: {
  inputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  outputTokens: number | undefined;
  reportedCostUsd: number | undefined;
}): AgentUsage {
  const usage: AgentUsage = {};
  if (input.inputTokens !== undefined) usage.inputTokens = input.inputTokens;
  if (input.cachedInputTokens !== undefined) usage.cachedInputTokens = input.cachedInputTokens;
  if (input.outputTokens !== undefined) usage.outputTokens = input.outputTokens;
  if (input.reportedCostUsd !== undefined) usage.reportedCostUsd = input.reportedCostUsd;
  return usage;
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
