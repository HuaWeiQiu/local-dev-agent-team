import type { LoadedConfig } from "./config/load.js";
import type { DoctorCheck } from "./adapters/types.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { qualityCommandAvailability } from "./quality/optional-tools.js";
import { SessionFactory } from "./sessions/factory.js";

export async function runDoctor(
  loaded: LoadedConfig,
  options: { probeModel: boolean; profileName?: string },
  registry = new AdapterRegistry(),
  sessions = new SessionFactory({ registry }),
): Promise<DoctorCheck[]> {
  const entries = selectedProfiles(loaded, options.profileName);
  const checks: DoctorCheck[] = [];
  for (const [profileName, profile] of entries) {
    checks.push(...(await profileChecks(loaded, options, registry, sessions, profileName, profile)));
  }
  checks.push(...(await qualityChecks(loaded)));
  return checks;
}

function selectedProfiles(
  loaded: LoadedConfig,
  profileName: string | undefined,
): Array<[string, LoadedConfig["config"]["profiles"][string]]> {
  const entries = Object.entries(loaded.config.profiles).filter(
    ([name]) => !profileName || name === profileName,
  );
  if (entries.length === 0) throw new Error(`Unknown profile '${profileName}'`);
  return entries;
}

type Profile = LoadedConfig["config"]["profiles"][string];

/** Adapter doctor first, then the session plan — but only for a live binary. */
async function profileChecks(
  loaded: LoadedConfig,
  options: { probeModel: boolean },
  registry: AdapterRegistry,
  sessions: SessionFactory,
  profileName: string,
  profile: Profile,
): Promise<DoctorCheck[]> {
  const adapter = registry.get(profile.adapter);
  const checks = await adapter.doctor({
    cwd: loaded.root,
    profileName,
    profile,
    probeModel: options.probeModel,
  });
  if (executableFailed(checks, profileName)) return checks;
  const plan = await sessions.plan(profile.adapter, profile, loaded.root);
  return [...checks, sessionCheck(profileName, profile, plan)];
}

function executableFailed(checks: DoctorCheck[], profileName: string): boolean {
  return checks.some(
    (check) =>
      check.profile === profileName && check.check === "executable" && check.status === "fail",
  );
}

function sessionCheck(
  profileName: string,
  profile: Profile,
  plan: Awaited<ReturnType<SessionFactory["plan"]>>,
): DoctorCheck {
  const enabled = Object.entries(plan.capabilities)
    .filter(([, on]) => on)
    .map(([name]) => name);
  const oneShot = plan.kind === "one-shot";
  return {
    profile: profileName,
    adapter: profile.adapter,
    check: "session",
    status: oneShot && plan.reason ? "skip" : "pass",
    detail: oneShot ? oneShotDetail(plan.reason) : interactiveDetail(plan, enabled),
  };
}

function oneShotDetail(reason: string | undefined): string {
  return reason ? `one-shot invocation (${reason})` : "one-shot invocation";
}

function interactiveDetail(
  plan: Awaited<ReturnType<SessionFactory["plan"]>>,
  enabled: string[],
): string {
  return `${plan.kind} ${plan.version ?? ""}: ${enabled.join(", ")}`.replace("  ", " ");
}

/** Optional quality CLIs (e.g. ocr) — fail when configured but missing. */
async function qualityChecks(loaded: LoadedConfig): Promise<DoctorCheck[]> {
  const availability = await qualityCommandAvailability(loaded.config.quality.commands);
  return availability.map((item) => ({
    profile: "quality",
    adapter: item.command,
    check: "quality-command",
    status: item.available ? "pass" : "fail",
    detail: item.available
      ? `Quality command '${item.command}' is available on PATH`
      : item.hint ??
        `Quality command '${item.command}' was not found on PATH; runs that execute it will fail`,
  }));
}
