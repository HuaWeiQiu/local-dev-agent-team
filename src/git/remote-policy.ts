export interface RemoteOwner {
  host: string;
  owner: string;
}

export function parseGitRemoteOwner(remoteUrl: string): RemoteOwner | undefined {
  const value = remoteUrl.trim();
  if (!value) return undefined;

  const ssh = value.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/[^/]+?(?:\.git)?$/i);
  if (ssh?.[1] && ssh[2]) {
    return { host: ssh[1].toLowerCase(), owner: ssh[2].toLowerCase() };
  }
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    const [, owner] = parsed.pathname.split("/");
    if (!owner) return undefined;
    return {
      host: parsed.hostname.toLowerCase(),
      owner: owner.replace(/\.git$/i, "").toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

export function normalizeAllowedOwner(entry: string): { host?: string; owner: string } {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.includes("/")) {
    const parsed = parseGitRemoteOwner(trimmed.includes("://") || trimmed.includes("@") ? trimmed : `https://${trimmed}`);
    if (parsed) return parsed;
  }
  return { owner: trimmed.replace(/^github\.com[:/]/, "") };
}

export function remoteOwnerAllowed(remoteUrl: string, allowedOwners: string[]): {
  allowed: boolean;
  owner?: RemoteOwner | undefined;
  reason?: string | undefined;
} {
  if (allowedOwners.length === 0) {
    const owner = parseGitRemoteOwner(remoteUrl);
    return owner ? { allowed: true, owner } : { allowed: true };
  }
  const owner = parseGitRemoteOwner(remoteUrl);
  if (!owner) {
    return { allowed: false, reason: `无法解析远端地址 '${remoteUrl}'，无法核对企业仓库白名单` };
  }
  const ok = allowedOwners.some((entry) => {
    const allowed = normalizeAllowedOwner(entry);
    if (allowed.owner !== owner.owner) return false;
    return !allowed.host || allowed.host === owner.host;
  });
  return ok
    ? { allowed: true, owner }
    : {
        allowed: false,
        owner,
        reason: `远端 ${owner.host}/${owner.owner} 不在企业仓库白名单（${allowedOwners.join("、")}）`,
      };
}
