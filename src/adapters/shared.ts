import { readFile } from "node:fs/promises";
import type { AgentInvocation, AgentRunResult } from "./types.js";
import type { AgentProfile } from "../config/schema.js";
import type { ProcessResult } from "../process/run.js";
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
