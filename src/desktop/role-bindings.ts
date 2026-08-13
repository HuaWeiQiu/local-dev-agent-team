import type { AgentProfile, AgentTeamConfig, Reasoning } from "../config/schema.js";
import type { RunRoleBinding, RunState } from "../state/types.js";
import type { RoleBinding } from "./settings.js";

const READ_ONLY_ROLES = new Set([
  "orchestrator",
  "architect",
  "researcher",
  "reviewer",
  "tester",
]);

const REASONING_BY_CLI: Record<string, readonly string[]> = {
  codex: ["low", "medium", "high", "xhigh", "max"],
  grok: ["low", "medium", "high"],
  claude: ["low", "medium", "high"],
  kimi: ["low", "medium", "high", "xhigh"],
};

export interface MaterializedBindings {
  /** Config clone with ephemeral profiles injected and allowed for roles. */
  config: AgentTeamConfig;
  /** role → ephemeral profile name */
  profileOverrides: Record<string, string>;
  /** audit trail */
  bindings: Record<string, RoleBinding & { profileName: string }>;
}

/**
 * Convert roleBindings into ephemeral project profiles for one run.
 * Does not write secrets; CLI adapters still read user home configs.
 */
export function materializeRoleBindings(
  base: AgentTeamConfig,
  bindings: Record<string, RoleBinding>,
): MaterializedBindings {
  const config: AgentTeamConfig = {
    ...base,
    profiles: { ...base.profiles },
    roles: Object.fromEntries(
      Object.entries(base.roles).map(([role, policy]) => [
        role,
        {
          ...policy,
          allowedProfiles: [...policy.allowedProfiles],
          fallbackProfiles: [...policy.fallbackProfiles],
        },
      ]),
    ),
  };

  const profileOverrides: Record<string, string> = {};
  const audit: Record<string, RoleBinding & { profileName: string }> = {};

  for (const [role, binding] of Object.entries(bindings)) {
    if (!config.roles[role]) {
      throw new Error(`Unknown role '${role}' in roleBindings`);
    }
    const adapter = binding.cli; // codex | grok | claude | kimi
    const reasoning = normalizeReasoning(binding.cli, binding.reasoning);
    const model = binding.model?.trim() || defaultModelForCli(binding.cli);
    const permission = READ_ONLY_ROLES.has(role) ? "read-only" : "workspace-write";
    const profileName = `runtime/${role}/${adapter}/${slug(model)}/${reasoning}`;

    const profile: AgentProfile = {
      adapter,
      model,
      reasoning,
      permission,
      externalTools: "deny",
      timeoutSeconds: permission === "read-only" ? 1_800 : 3_600,
      args: [],
      ...(adapter === "grok" ? { maxTurns: 24 } : {}),
    };

    // Prefer project-defined codex provider if any codex profile already has one
    if (adapter === "codex") {
      const donor = Object.values(base.profiles).find(
        (item) => item.adapter === "codex" && item.codexProvider,
      );
      if (donor?.codexProvider) {
        profile.codexProvider = { ...donor.codexProvider };
      }
    }

    config.profiles[profileName] = profile;
    if (!config.roles[role]!.allowedProfiles.includes(profileName)) {
      config.roles[role]!.allowedProfiles.push(profileName);
    }
    profileOverrides[role] = profileName;
    audit[role] = { ...binding, model, reasoning, profileName };
  }

  return { config, profileOverrides, bindings: audit };
}

const RUNTIME_PROFILE_NAME =
  /^runtime\/([^/]+)\/(codex|grok|kimi|claude)\/(.+)\/([^/]+)$/;

/** Recover picker bindings from a persisted run so resume can rebuild ephemeral profiles. */
export function roleBindingsFromRunState(state: {
  profileOverrides: Record<string, string>;
  roleBindings?: Record<string, RunRoleBinding>;
}): Record<string, RoleBinding> {
  if (state.roleBindings && Object.keys(state.roleBindings).length > 0) {
    return Object.fromEntries(
      Object.entries(state.roleBindings).map(([role, binding]) => [
        role,
        roleBindingFromPersisted(binding),
      ]),
    );
  }

  const recovered: Record<string, RoleBinding> = {};
  for (const [role, profileName] of Object.entries(state.profileOverrides ?? {})) {
    const parsed = parseRuntimeProfileName(profileName);
    if (!parsed || parsed.role !== role) continue;
    recovered[role] = {
      cli: parsed.cli,
      model: parsed.model,
      reasoning: parsed.reasoning,
    };
  }
  return recovered;
}

export function parseRuntimeProfileName(profileName: string): {
  role: string;
  cli: RoleBinding["cli"];
  model: string;
  reasoning: string;
} | undefined {
  const match = RUNTIME_PROFILE_NAME.exec(profileName);
  if (!match) return undefined;
  return {
    role: match[1]!,
    cli: match[2] as RoleBinding["cli"],
    model: match[3]!,
    reasoning: match[4]!,
  };
}

function roleBindingFromPersisted(binding: RunRoleBinding): RoleBinding {
  return {
    cli: binding.cli,
    ...(binding.model ? { model: binding.model } : {}),
    ...(binding.reasoning ? { reasoning: binding.reasoning } : {}),
  };
}

function defaultModelForCli(cli: string): string {
  switch (cli) {
    case "codex":
      return "gpt-5.6-sol";
    case "grok":
      return "grok";
    case "claude":
      return "sonnet";
    case "kimi":
      return "kimi-code";
    default:
      return "default";
  }
}

function normalizeReasoning(cli: string, value?: string): Reasoning {
  const allowed = REASONING_BY_CLI[cli] ?? ["medium", "high"];
  const candidate = (value ?? "high").toLowerCase();
  if (allowed.includes(candidate)) {
    return candidate as Reasoning;
  }
  // map max→high for grok/claude
  if (candidate === "max" || candidate === "xhigh") {
    if (allowed.includes("high")) return "high";
  }
  return (allowed.includes("high") ? "high" : allowed[0]!) as Reasoning;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "model";
}

