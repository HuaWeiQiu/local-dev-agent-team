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
  const entries = Object.entries(loaded.config.profiles).filter(
    ([name]) => !options.profileName || name === options.profileName,
  );
  if (entries.length === 0) {
    throw new Error(`Unknown profile '${options.profileName}'`);
  }

  const checks: DoctorCheck[] = [];
  for (const [profileName, profile] of entries) {
    const adapter = registry.get(profile.adapter);
    checks.push(
      ...(await adapter.doctor({
        cwd: loaded.root,
        profileName,
        profile,
        probeModel: options.probeModel,
      })),
    );
    const executable = checks.find(
      (check) => check.profile === profileName && check.check === "executable",
    );
    if (executable?.status === "fail") continue;
    const plan = await sessions.plan(profile.adapter, profile, loaded.root);
    const enabled = Object.entries(plan.capabilities)
      .filter(([, on]) => on)
      .map(([name]) => name);
    checks.push({
      profile: profileName,
      adapter: profile.adapter,
      check: "session",
      status: plan.kind === "one-shot" && plan.reason ? "skip" : "pass",
      detail:
        plan.kind === "one-shot"
          ? `one-shot invocation${plan.reason ? ` (${plan.reason})` : ""}`
          : `${plan.kind} ${plan.version ?? ""}: ${enabled.join(", ")}`.replace("  ", " "),
    });
  }

  // Optional quality CLIs (e.g. ocr) — fail when configured but missing.
  const quality = await qualityCommandAvailability(loaded.config.quality.commands);
  for (const item of quality) {
    checks.push({
      profile: "quality",
      adapter: item.command,
      check: "quality-command",
      status: item.available ? "pass" : "fail",
      detail: item.available
        ? `Quality command '${item.command}' is available on PATH`
        : item.hint ??
          `Quality command '${item.command}' was not found on PATH; runs that execute it will fail`,
    });
  }

  return checks;
}
