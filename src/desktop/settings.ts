import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CliId, CliInventory } from "./cli-inventory.js";
import { scanCliInventory } from "./cli-inventory.js";

const roleBindingSchema = z.object({
  cli: z.enum(["codex", "grok", "kimi", "claude"]),
  model: z.string().min(1).max(200).optional(),
  reasoning: z.string().min(1).max(64).optional(),
});

const desktopSettingsSchema = z.object({
  version: z.literal(1),
  inventoryCache: z.unknown().optional(),
  inventoryCachedAt: z.string().optional(),
  defaults: z.object({
    roles: z.record(z.string(), roleBindingSchema).default({}),
  }).default({ roles: {} }),
  ui: z.object({
    showCliPickerInRunLauncher: z.boolean().default(true),
  }).default({ showCliPickerInRunLauncher: true }),
});

export type RoleBinding = z.infer<typeof roleBindingSchema>;
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>;

export const WORKFLOW_ROLES = [
  "orchestrator",
  "architect",
  "worker",
  "reviewer",
  "tester",
] as const;

export function desktopSettingsPath(home = homedir()): string {
  return path.join(home, ".agent-team", "desktop-settings.json");
}

export async function loadDesktopSettings(home = homedir()): Promise<DesktopSettings> {
  const filePath = desktopSettingsPath(home);
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return desktopSettingsSchema.parse(raw);
  } catch {
    return desktopSettingsSchema.parse({ version: 1 });
  }
}

export async function saveDesktopSettings(
  settings: DesktopSettings,
  home = homedir(),
): Promise<DesktopSettings> {
  const parsed = desktopSettingsSchema.parse(settings);
  const filePath = desktopSettingsPath(home);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

export async function getInventory(
  options: { refresh?: boolean; maxAgeMs?: number; home?: string } = {},
): Promise<{ inventory: CliInventory; fromCache: boolean }> {
  const home = options.home ?? homedir();
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
  const settings = await loadDesktopSettings(home);
  if (!options.refresh && settings.inventoryCache && settings.inventoryCachedAt) {
    const age = Date.now() - Date.parse(settings.inventoryCachedAt);
    if (Number.isFinite(age) && age >= 0 && age < maxAgeMs) {
      return {
        inventory: settings.inventoryCache as CliInventory,
        fromCache: true,
      };
    }
  }
  const inventory = await scanCliInventory(home);
  await saveDesktopSettings({
    ...settings,
    inventoryCache: inventory,
    inventoryCachedAt: inventory.scannedAt,
  }, home);
  return { inventory, fromCache: false };
}

/** Build default role bindings from inventory when user has not set defaults. */
export function suggestDefaultsFromInventory(inventory: CliInventory): Record<string, RoleBinding> {
  const byId = new Map(inventory.clis.map((cli) => [cli.id, cli]));
  const pick = (preferred: CliId[]): RoleBinding => {
    for (const id of preferred) {
      const cli = byId.get(id);
      if (cli?.installed && cli.runtimeSupported) {
        return {
          cli: id,
          ...(cli.defaultModel ? { model: cli.defaultModel } : {}),
          ...(cli.defaultReasoning ? { reasoning: cli.defaultReasoning } : { reasoning: "high" }),
        };
      }
    }
    // fall back to first runtime-supported installed cli
    for (const cli of inventory.clis) {
      if (cli.installed && cli.runtimeSupported) {
        return {
          cli: cli.id,
          ...(cli.defaultModel ? { model: cli.defaultModel } : {}),
          reasoning: cli.defaultReasoning ?? "high",
        };
      }
    }
    return { cli: "grok", model: "grok", reasoning: "high" };
  };

  return {
    orchestrator: pick(["codex", "grok", "claude"]),
    architect: pick(["grok", "codex", "claude"]),
    worker: pick(["grok", "codex", "claude"]),
    reviewer: pick(["grok", "codex", "claude"]),
    tester: pick(["grok", "codex", "claude"]),
  };
}

export function mergeRoleDefaults(
  settings: DesktopSettings,
  inventory: CliInventory,
): Record<string, RoleBinding> {
  const suggested = suggestDefaultsFromInventory(inventory);
  const merged: Record<string, RoleBinding> = { ...suggested };
  for (const [role, binding] of Object.entries(settings.defaults.roles)) {
    merged[role] = binding;
  }
  return merged;
}
