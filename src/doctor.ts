import type { LoadedConfig } from "./config/load.js";
import type { DoctorCheck } from "./adapters/types.js";
import { AdapterRegistry } from "./adapters/registry.js";

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
  return checks;
}
