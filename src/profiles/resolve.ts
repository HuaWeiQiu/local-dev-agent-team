import type { AgentProfile, AgentTeamConfig } from "../config/schema.js";

export interface ResolvedProfile {
  name: string;
  profile: AgentProfile;
  usedFallback: boolean;
}

export function resolveProfile(
  config: AgentTeamConfig,
  roleName: string,
  requestedProfile?: string,
): ResolvedProfile {
  const role = config.roles[roleName];
  if (!role) {
    throw new Error(`Unknown role '${roleName}'`);
  }

  const profileName = requestedProfile ?? role.defaultProfile;
  if (!role.allowedProfiles.includes(profileName)) {
    throw new Error(`Profile '${profileName}' is not allowed for role '${roleName}'`);
  }
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`Unknown profile '${profileName}'`);
  }

  return { name: profileName, profile, usedFallback: false };
}

export function fallbackProfiles(
  config: AgentTeamConfig,
  roleName: string,
): ResolvedProfile[] {
  const role = config.roles[roleName];
  if (!role) {
    throw new Error(`Unknown role '${roleName}'`);
  }
  return role.fallbackProfiles.map((name) => {
    const profile = config.profiles[name];
    if (!profile) {
      throw new Error(`Unknown fallback profile '${name}'`);
    }
    return { name, profile, usedFallback: true };
  });
}
