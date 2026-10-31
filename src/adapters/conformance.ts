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

/** Roles designed to run read-only; only the worker may write to the workspace. */
const readOnlyDesignedRoles = new Set([
  "orchestrator",
  "architect",
  "researcher",
  "reviewer",
  "tester",
]);

/**
 * Warning-level diagnostic for soft permission enforcement.
 *
 * Unlike the other adapters, the Kimi CLI has no non-interactive flag that
 * enforces read-only at the execution layer; the adapter relies on prompt
 * constraints only. Binding a read-only-designed role to a Kimi profile is
 * allowed (existing configurations depend on it) but must be surfaced.
 */
export function adapterRoleWarning(role: string, profile: AgentProfile): string | undefined {
  if (
    profile.adapter === "kimi" &&
    profile.permission === "read-only" &&
    readOnlyDesignedRoles.has(role)
  ) {
    return (
      `Role '${role}' runs on a Kimi profile with read-only permission: ` +
      "kimi permission constraints are prompt-based only, with no execution-layer enforcement"
    );
  }
  return undefined;
}

export function assertAdapterContract(adapter: AgentAdapter): void {
  assertIdentity(adapter);
  assertDeclarationLists(adapter);
  if (typeof adapter.contract.structuredOutput !== "boolean") {
    throw new Error(`Adapter '${adapter.name}' declares invalid structured-output support`);
  }
}

function assertIdentity(adapter: AgentAdapter): void {
  if (!adapterNamePattern.test(adapter.name)) {
    throw new Error(`Invalid agent adapter name '${adapter.name}'`);
  }
  if (adapter.contract.version !== 1 || adapter.contract.transport !== "local-process") {
    throw new Error(`Adapter '${adapter.name}' uses an unsupported contract`);
  }
}

/**
 * Every declared list must be unique and drawn from the known values; only the
 * capability lists must also be non-empty — an adapter may report no usage.
 */
function assertDeclarationLists(adapter: AgentAdapter): void {
  const required: Array<[string, readonly string[], ReadonlySet<string>]> = [
    ["reasoning level", adapter.supportedReasoning, reasoningValues],
    ["permission", adapter.contract.permissions, permissionValues],
    ["external-tools policy", adapter.contract.externalTools, externalToolsValues],
  ];
  for (const [label, values, allowed] of required) {
    assertUniqueNonEmpty(adapter.name, label, values);
    assertAllowed(adapter.name, label, values, allowed);
  }
  assertUnique(adapter.name, "usage field", adapter.contract.usage);
  assertAllowed(adapter.name, "usage field", adapter.contract.usage, usageValues);
}

export function assertAdapterProfile(
  adapter: AgentAdapter,
  profile: AgentProfile,
  structuredOutput: boolean,
): void {
  for (const rule of PROFILE_RULES) {
    const failure = rule(adapter, profile, structuredOutput);
    if (failure) throw new Error(failure);
  }
}

type ProfileRule = (
  adapter: AgentAdapter,
  profile: AgentProfile,
  structuredOutput: boolean,
) => string | undefined;

/** Every reason a profile cannot run on an adapter, in check order. */
const PROFILE_RULES: ProfileRule[] = [
  (adapter, profile) =>
    profile.adapter === adapter.name
      ? undefined
      : `Profile adapter '${profile.adapter}' does not match requested adapter '${adapter.name}'`,
  (adapter, profile) =>
    profile.nativeProfile && adapter.name !== "codex"
      ? "nativeProfile is supported only by the Codex adapter"
      : undefined,
  (adapter, profile) =>
    profile.maxTurns !== undefined && adapter.name !== "grok"
      ? "maxTurns is currently supported only by the Grok adapter"
      : undefined,
  (adapter, profile) =>
    adapter.supportedReasoning.includes(profile.reasoning)
      ? undefined
      : `Adapter '${adapter.name}' does not support reasoning '${profile.reasoning}'`,
  (adapter, profile) =>
    adapter.contract.permissions.includes(profile.permission)
      ? undefined
      : `Adapter '${adapter.name}' does not support permission '${profile.permission}'`,
  (adapter, profile) =>
    adapter.contract.externalTools.includes(profile.externalTools)
      ? undefined
      : `Adapter '${adapter.name}' does not support external-tools policy '${profile.externalTools}'`,
  (_adapter, profile) =>
    profile.permission === "read-only" && profile.externalTools === "inherit"
      ? "Read-only profiles cannot inherit external MCP tools"
      : undefined,
  (adapter, _profile, structuredOutput) =>
    structuredOutput && !adapter.contract.structuredOutput
      ? `Adapter '${adapter.name}' does not support structured output`
      : undefined,
];

export function assertInvocationContract(
  adapter: AgentAdapter,
  profile: AgentProfile,
  request: AgentInvocationRequest,
  invocation: AgentInvocation,
): void {
  for (const rule of INVOCATION_RULES) {
    const failure = rule({ adapter, profile, request, invocation });
    if (failure) throw new Error(failure);
  }
}

interface InvocationContext {
  adapter: AgentAdapter;
  profile: AgentProfile;
  request: AgentInvocationRequest;
  invocation: AgentInvocation;
}

/** Every way an invocation may break its contract, in check order. */
const INVOCATION_RULES: Array<(context: InvocationContext) => string | undefined> = [
  ({ adapter, invocation }) =>
    invocation.command.trim() ? undefined : `Adapter '${adapter.name}' returned an empty executable`,
  ({ adapter, request, invocation }) =>
    invocation.cwd === request.cwd
      ? undefined
      : `Adapter '${adapter.name}' changed the managed working directory`,
  ({ adapter, request, invocation }) =>
    adapter.promptTransport === "file" ? filePromptFailure(adapter, request, invocation) : undefined,
  ({ adapter, request, invocation }) =>
    adapter.promptTransport !== "file" && invocation.stdin !== request.prompt
      ? `Adapter '${adapter.name}' must pass the prompt through stdin`
      : undefined,
  ({ adapter, profile, invocation }) =>
    validTimeout(invocation.timeoutMs, profile.timeoutSeconds)
      ? undefined
      : `Adapter '${adapter.name}' returned an invalid process timeout`,
  ({ adapter, request, invocation }) =>
    invocation.outputFile && invocation.outputFile !== request.outputFile
      ? `Adapter '${adapter.name}' changed the managed output path`
      : undefined,
];

/** A file-delivered prompt must arrive once, at the managed path. */
function filePromptFailure(
  adapter: AgentAdapter,
  request: AgentInvocationRequest,
  invocation: AgentInvocation,
): string | undefined {
  if (!request.promptFile || invocation.promptFile !== request.promptFile) {
    return `Adapter '${adapter.name}' changed the managed prompt path`;
  }
  if (invocation.stdin !== undefined) {
    return `Adapter '${adapter.name}' must not duplicate a file-delivered prompt`;
  }
  return undefined;
}

function validTimeout(timeoutMs: number, timeoutSeconds: number): boolean {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= timeoutSeconds * 1_000;
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
