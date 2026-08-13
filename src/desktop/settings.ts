import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CliId, CliInventory } from "./cli-inventory.js";
import { inventorySourceFingerprint, scanCliInventory } from "./cli-inventory.js";

const roleBindingSchema = z.object({
  cli: z.enum(["codex", "grok", "kimi", "claude"]),
  model: z.string().min(1).max(200).optional(),
  reasoning: z.string().min(1).max(64).optional(),
});

const desktopSettingsSchema = z.object({
  version: z.literal(1),
  inventoryCache: z.unknown().optional(),
  inventoryCachedAt: z.string().optional(),
  /** Last known fingerprint of watched CLI config files (mtime/size). */
  inventorySourceFingerprint: z.string().optional(),
  defaults: z.object({
    roles: z.record(z.string(), roleBindingSchema).default({}),
  }).default({ roles: {} }),
  ui: z.object({
    showCliPickerInRunLauncher: z.boolean().default(true),
    /** When true, settings/launcher soft-check config fingerprints on focus & interval. */
    autoDetectCliConfig: z.boolean().default(true),
    /** When true, window focus/visibility triggers a soft inventory check. */
    autoDetectOnFocus: z.boolean().default(true),
  }).default({
    showCliPickerInRunLauncher: true,
    autoDetectCliConfig: true,
    autoDetectOnFocus: true,
  }),
});

export type RoleBinding = z.infer<typeof roleBindingSchema>;
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>;

export const WORKFLOW_ROLES = [
  "orchestrator",
  "architect",
  "researcher",
  "worker",
  "reviewer",
  "tester",
] as const;

/** Soft TTL when config files are unchanged. Fingerprint mismatch always wins. */
export const DEFAULT_INVENTORY_MAX_AGE_MS = 15 * 60 * 1000;

export function desktopSettingsPath(home = homedir()): string {
  return path.join(home, ".agent-team", "desktop-settings.json");
}

export async function loadDesktopSettings(home = homedir()): Promise<DesktopSettings> {
  const filePath = desktopSettingsPath(home);
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    // The file may carry role bindings; tighten permissions of files written
    // before mode 0600 became the default. Best-effort, never blocks loading.
    await chmod(filePath, 0o600).catch(() => {});
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
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFile's mode only applies at creation; enforce 0600 on rewrites too.
  await chmod(filePath, 0o600).catch(() => {});
  return parsed;
}

export async function getInventory(
  options: { refresh?: boolean; maxAgeMs?: number; home?: string } = {},
): Promise<{ inventory: CliInventory; fromCache: boolean; reason: "refresh" | "stale" | "fingerprint" | "miss" | "hit" }> {
  const home = options.home ?? homedir();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_INVENTORY_MAX_AGE_MS;
  const settings = await loadDesktopSettings(home);
  const currentFingerprint = await inventorySourceFingerprint(home);

  if (!options.refresh && settings.inventoryCache && settings.inventoryCachedAt) {
    const age = Date.now() - Date.parse(settings.inventoryCachedAt);
    const cached = settings.inventoryCache as CliInventory;
    const cachedFingerprint =
      settings.inventorySourceFingerprint
      ?? cached.sourceFingerprint
      ?? "";
    const fingerprintMatch = cachedFingerprint !== "" && cachedFingerprint === currentFingerprint;
    const ageOk = Number.isFinite(age) && age >= 0 && age < maxAgeMs;
    if (ageOk && fingerprintMatch) {
      return {
        inventory: {
          ...cached,
          sourceFingerprint: cachedFingerprint,
        },
        fromCache: true,
        reason: "hit",
      };
    }
    // Fall through to rescan; fingerprint change is the primary invalidation signal.
  }

  const inventory = await scanCliInventory(home);
  const reason = options.refresh
    ? "refresh"
    : !settings.inventoryCache
      ? "miss"
      : (settings.inventorySourceFingerprint ?? (settings.inventoryCache as CliInventory).sourceFingerprint) !== currentFingerprint
        ? "fingerprint"
        : "stale";

  await saveDesktopSettings({
    ...settings,
    inventoryCache: inventory,
    inventoryCachedAt: inventory.scannedAt,
    inventorySourceFingerprint: inventory.sourceFingerprint ?? currentFingerprint,
  }, home);
  return { inventory, fromCache: false, reason };
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
    return { cli: "grok", model: "grok-4.6", reasoning: "high" };
  };

  return {
    orchestrator: pick(["codex", "grok", "claude"]),
    architect: pick(["grok", "codex", "claude"]),
    researcher: pick(["grok", "codex", "claude", "kimi"]),
    worker: pick(["grok", "codex", "claude"]),
    reviewer: pick(["grok", "codex", "claude"]),
    tester: pick(["grok", "codex", "claude"]),
  };
}

/**
 * Drop or fix model / reasoning choices that no longer exist after a CLI config change.
 * Does not rewrite persisted settings — callers decide whether to save.
 */
export function sanitizeRoleBindings(
  roles: Record<string, RoleBinding>,
  inventory: CliInventory,
): { roles: Record<string, RoleBinding>; changed: boolean; notes: string[] } {
  const byId = new Map(inventory.clis.map((cli) => [cli.id, cli]));
  let changed = false;
  const notes: string[] = [];
  const next: Record<string, RoleBinding> = {};

  for (const [role, binding] of Object.entries(roles)) {
    const cli = byId.get(binding.cli);
    if (!cli) {
      next[role] = binding;
      continue;
    }

    let model = binding.model;
    let reasoning = binding.reasoning;

    if (model && cli.models.length > 0 && !cli.models.some((item) => item.id === model)) {
      const fallback = cli.defaultModel ?? cli.models[0]?.id;
      if (fallback) {
        notes.push(`${role}: 模型「${model}」已不在 ${cli.id} 列表，已改为「${fallback}」`);
        model = fallback;
        changed = true;
      }
    }

    const modelInfo = cli.models.find((item) => item.id === (model ?? binding.model));
    const reasoningOptions = modelInfo?.reasoningOptions ?? [];
    if (reasoning && reasoningOptions.length > 0 && !reasoningOptions.includes(reasoning)) {
      const fallback = cli.defaultReasoning ?? reasoningOptions[0] ?? "high";
      notes.push(`${role}: 思考深度「${reasoning}」不可用，已改为「${fallback}」`);
      reasoning = fallback;
      changed = true;
    }

    next[role] = {
      cli: binding.cli,
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  return { roles: next, changed, notes };
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
  return sanitizeRoleBindings(merged, inventory).roles;
}
