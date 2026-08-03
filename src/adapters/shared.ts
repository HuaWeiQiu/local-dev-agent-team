import { readFile } from "node:fs/promises";
import type { AgentInvocation, AgentRunResult } from "./types.js";
import type { AgentProfile } from "../config/schema.js";
import type { ProcessResult } from "../process/run.js";

const reservedArguments = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-skip-permissions",
  "--sandbox",
  "--permission-mode",
  "--model",
  "-m",
  "--cd",
  "-C",
  "--output-schema",
  "--json-schema",
  "--output-last-message",
  "-o",
]);

export function validateProfileArguments(profile: AgentProfile): void {
  for (const argument of profile.args) {
    const key = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (reservedArguments.has(key)) {
      throw new Error(`Profile argument '${key}' is managed by the adapter and cannot be overridden`);
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

  return structured === undefined
    ? { text, process }
    : { text, structured, process };
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
    return structured === undefined
      ? { text: result, process }
      : { text: result, structured, process };
  } catch {
    return { text, process };
  }
}
