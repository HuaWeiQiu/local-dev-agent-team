import type { AgentProfile } from "../config/schema.js";
import type {
  AgentAdapter,
  AgentInvocation,
  AgentInvocationRequest,
} from "./types.js";

const adapterNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
const reasoningValues = new Set(["low", "medium", "high", "xhigh", "max"]);
const permissionValues = new Set(["read-only", "workspace-write"]);
const externalToolsValues = new Set(["deny", "inherit"]);
const usageValues = new Set([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reportedCostUsd",
]);

export function assertAdapterContract(adapter: AgentAdapter): void {
  if (!adapterNamePattern.test(adapter.name)) {
    throw new Error(`Invalid agent adapter name '${adapter.name}'`);
  }
  if (adapter.contract.version !== 1 || adapter.contract.transport !== "local-process") {
    throw new Error(`Adapter '${adapter.name}' uses an unsupported contract`);
  }
  assertUniqueNonEmpty(adapter.name, "reasoning level", adapter.supportedReasoning);
  assertUniqueNonEmpty(adapter.name, "permission", adapter.contract.permissions);
  assertUniqueNonEmpty(adapter.name, "external-tools policy", adapter.contract.externalTools);
  assertUnique(adapter.name, "usage field", adapter.contract.usage);
  assertAllowed(adapter.name, "reasoning level", adapter.supportedReasoning, reasoningValues);
  assertAllowed(adapter.name, "permission", adapter.contract.permissions, permissionValues);
  assertAllowed(
    adapter.name,
    "external-tools policy",
    adapter.contract.externalTools,
    externalToolsValues,
  );
  assertAllowed(adapter.name, "usage field", adapter.contract.usage, usageValues);
  if (typeof adapter.contract.structuredOutput !== "boolean") {
    throw new Error(`Adapter '${adapter.name}' declares invalid structured-output support`);
  }
}

export function assertAdapterProfile(
  adapter: AgentAdapter,
  profile: AgentProfile,
  structuredOutput: boolean,
): void {
  if (profile.adapter !== adapter.name) {
    throw new Error(
      `Profile adapter '${profile.adapter}' does not match requested adapter '${adapter.name}'`,
    );
  }
  if (profile.nativeProfile && adapter.name !== "codex") {
    throw new Error("nativeProfile is supported only by the Codex adapter");
  }
  if (profile.maxTurns !== undefined && adapter.name !== "grok") {
    throw new Error("maxTurns is currently supported only by the Grok adapter");
  }
  if (!adapter.supportedReasoning.includes(profile.reasoning)) {
    throw new Error(
      `Adapter '${adapter.name}' does not support reasoning '${profile.reasoning}'`,
    );
  }
  if (!adapter.contract.permissions.includes(profile.permission)) {
    throw new Error(
      `Adapter '${adapter.name}' does not support permission '${profile.permission}'`,
    );
  }
  if (!adapter.contract.externalTools.includes(profile.externalTools)) {
    throw new Error(
      `Adapter '${adapter.name}' does not support external-tools policy '${profile.externalTools}'`,
    );
  }
  if (profile.permission === "read-only" && profile.externalTools === "inherit") {
    throw new Error("Read-only profiles cannot inherit external MCP tools");
  }
  if (structuredOutput && !adapter.contract.structuredOutput) {
    throw new Error(`Adapter '${adapter.name}' does not support structured output`);
  }
}

export function assertInvocationContract(
  adapter: AgentAdapter,
  profile: AgentProfile,
  request: AgentInvocationRequest,
  invocation: AgentInvocation,
): void {
  if (!invocation.command.trim()) {
    throw new Error(`Adapter '${adapter.name}' returned an empty executable`);
  }
  if (invocation.cwd !== request.cwd) {
    throw new Error(`Adapter '${adapter.name}' changed the managed working directory`);
  }
  if (adapter.promptTransport === "file") {
    if (!request.promptFile || invocation.promptFile !== request.promptFile) {
      throw new Error(`Adapter '${adapter.name}' changed the managed prompt path`);
    }
    if (invocation.stdin !== undefined) {
      throw new Error(`Adapter '${adapter.name}' must not duplicate a file-delivered prompt`);
    }
  } else if (invocation.stdin !== request.prompt) {
    throw new Error(`Adapter '${adapter.name}' must pass the prompt through stdin`);
  }
  if (
    !Number.isFinite(invocation.timeoutMs) ||
    invocation.timeoutMs <= 0 ||
    invocation.timeoutMs > profile.timeoutSeconds * 1_000
  ) {
    throw new Error(`Adapter '${adapter.name}' returned an invalid process timeout`);
  }
  if (invocation.outputFile && invocation.outputFile !== request.outputFile) {
    throw new Error(`Adapter '${adapter.name}' changed the managed output path`);
  }
}

function assertUniqueNonEmpty(
  adapterName: string,
  label: string,
  values: readonly string[],
): void {
  if (values.length === 0) {
    throw new Error(`Adapter '${adapterName}' must declare at least one ${label}`);
  }
  assertUnique(adapterName, label, values);
}

function assertUnique(adapterName: string, label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Adapter '${adapterName}' declares duplicate ${label} values`);
  }
}

function assertAllowed(
  adapterName: string,
  label: string,
  values: readonly string[],
  allowed: ReadonlySet<string>,
): void {
  const unsupported = values.find((value) => !allowed.has(value));
  if (unsupported) {
    throw new Error(`Adapter '${adapterName}' declares unsupported ${label} '${unsupported}'`);
  }
}
