import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  loadDesktopSettings,
  mergeRoleDefaults,
  sanitizeRoleBindings,
  type RoleBinding,
} from "./settings.js";
import type { CliInventory } from "./cli-inventory.js";

const roleBindingSchema = z.object({
  cli: z.enum(["codex", "grok", "kimi", "claude"]),
  model: z.string().min(1).max(200).optional(),
  reasoning: z.string().min(1).max(64).optional(),
});

const projectRoleSettingsSchema = z.object({
  version: z.literal(1),
  roles: z.record(z.string(), roleBindingSchema).default({}),
});

export type ProjectRoleSettings = z.infer<typeof projectRoleSettingsSchema>;

export function projectRoleSettingsPath(root: string, stateDirectory: string): string {
  return path.join(path.resolve(root), stateDirectory, "role-settings.json");
}

export async function loadProjectRoleSettings(
  root: string,
  stateDirectory: string,
): Promise<ProjectRoleSettings> {
  const filePath = projectRoleSettingsPath(root, stateDirectory);
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    await chmod(filePath, 0o600).catch(() => {});
    return projectRoleSettingsSchema.parse(raw);
  } catch {
    return projectRoleSettingsSchema.parse({ version: 1 });
  }
}

export async function saveProjectRoleSettings(
  root: string,
  stateDirectory: string,
  settings: ProjectRoleSettings,
): Promise<ProjectRoleSettings> {
  const parsed = projectRoleSettingsSchema.parse(settings);
  const filePath = projectRoleSettingsPath(root, stateDirectory);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
  return parsed;
}

/** Project override wins per role; missing project roles keep the global binding. */
export function mergeLayeredRoleBindings(
  globalRoles: Record<string, RoleBinding>,
  projectRoles: Record<string, RoleBinding>,
): Record<string, RoleBinding> {
  return { ...globalRoles, ...projectRoles };
}

export function roleBindingSources(
  globalRoles: Record<string, RoleBinding>,
  projectRoles: Record<string, RoleBinding>,
): Record<string, "global" | "project"> {
  const names = new Set([...Object.keys(globalRoles), ...Object.keys(projectRoles)]);
  const sources: Record<string, "global" | "project"> = {};
  for (const role of names) {
    sources[role] = role in projectRoles ? "project" : "global";
  }
  return sources;
}

/**
 * Bindings that should actually start a run when the caller did not send any.
 * Only user-saved global + project overrides — never inventory suggestions —
 * so CLI / tests keep using project yaml until someone saved defaults.
 */
export async function resolveLayeredRoleBindings(options: {
  root: string;
  stateDirectory: string;
  requestBindings?: Record<string, RoleBinding>;
  knownRoles?: Iterable<string>;
  home?: string;
  inventory?: CliInventory;
}): Promise<Record<string, RoleBinding> | undefined> {
  if (options.requestBindings && Object.keys(options.requestBindings).length > 0) {
    return filterKnownRoles(options.requestBindings, options.knownRoles);
  }

  const home = options.home ?? homedir();
  const [globalSettings, projectSettings] = await Promise.all([
    loadDesktopSettings(home),
    loadProjectRoleSettings(options.root, options.stateDirectory),
  ]);
  const savedGlobal = options.inventory
    ? sanitizeRoleBindings(globalSettings.defaults.roles, options.inventory).roles
    : globalSettings.defaults.roles;
  const savedProject = options.inventory
    ? sanitizeRoleBindings(projectSettings.roles, options.inventory).roles
    : projectSettings.roles;
  const merged = mergeLayeredRoleBindings(savedGlobal, savedProject);
  return filterKnownRoles(merged, options.knownRoles);
}

export function displayLayeredRoleBindings(
  globalRoles: Record<string, RoleBinding>,
  projectRoles: Record<string, RoleBinding>,
  inventory: CliInventory,
): {
  global: Record<string, RoleBinding>;
  project: Record<string, RoleBinding>;
  effective: Record<string, RoleBinding>;
  sources: Record<string, "global" | "project">;
} {
  const global = sanitizeRoleBindings(globalRoles, inventory).roles;
  const project = sanitizeRoleBindings(projectRoles, inventory).roles;
  const effective = mergeLayeredRoleBindings(global, project);
  return {
    global,
    project,
    effective,
    sources: roleBindingSources(global, project),
  };
}

export async function loadLayeredRoleDisplay(options: {
  root: string;
  stateDirectory: string;
  inventory: CliInventory;
  home?: string;
}): Promise<{
  global: Record<string, RoleBinding>;
  project: Record<string, RoleBinding>;
  effective: Record<string, RoleBinding>;
  sources: Record<string, "global" | "project">;
}> {
  const home = options.home ?? homedir();
  const [settings, projectSettings] = await Promise.all([
    loadDesktopSettings(home),
    loadProjectRoleSettings(options.root, options.stateDirectory),
  ]);
  const global = mergeRoleDefaults(settings, options.inventory);
  return displayLayeredRoleBindings(global, projectSettings.roles, options.inventory);
}

function filterKnownRoles(
  roles: Record<string, RoleBinding>,
  knownRoles: Iterable<string> | undefined,
): Record<string, RoleBinding> | undefined {
  const filtered = knownRoles
    ? Object.fromEntries(
        Object.entries(roles).filter(([role]) => new Set(knownRoles).has(role)),
      )
    : roles;
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
