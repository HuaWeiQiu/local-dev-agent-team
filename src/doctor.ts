import type { LoadedConfig } from "./config/load.js";
import type { DoctorCheck } from "./adapters/types.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { qualityCommandAvailability } from "./quality/optional-tools.js";

export async function runDoctor(
  loaded: LoadedConfig,
  options: { probeModel: boolean; profileName?: string },
  registry = new AdapterRegistry(),
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
