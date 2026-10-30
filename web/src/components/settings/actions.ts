import {
  getDesktopSettings,
  getProjectRoleSettings,
  saveDesktopSettings,
  saveProjectRoleSettings,
  scanCliInventory,
} from "../../api";
import type {
  CliInventory,
  DesktopSettingsResponse,
  DesktopSettingsView,
  ProjectRoleSettingsView,
  ProjectScope,
  RoleBindingInput,
} from "../../types";
import { globalSettingsPayload, projectRolePayload, type UiState } from "./model";

/** Force a fresh CLI inventory scan and report the cache reason it produced. */
export async function rescanInventory(): Promise<{
  inventory: CliInventory;
  reason: string;
  settings: DesktopSettingsResponse;
}> {
  const result = await scanCliInventory();
  const settings = await getDesktopSettings();
  return {
    inventory: result.inventory,
    reason: result.reason ?? "refresh",
    settings,
  };
}

export async function loadDesktopSettings(): Promise<DesktopSettingsResponse> {
  return await getDesktopSettings();
}

export async function loadProjectRoles(
  scope: ProjectScope,
): Promise<ProjectRoleSettingsView> {
  return await getProjectRoleSettings(scope);
}

/** Persist project overrides; roles the project does not own are cleared. */
export async function saveProjectRoles(input: {
  scope: ProjectScope;
  roleNames: string[];
  sources: Record<string, "global" | "project">;
  projectRoles: Record<string, RoleBindingInput>;
}): Promise<ProjectRoleSettingsView> {
  const payload = projectRolePayload(input.roleNames, input.sources, input.projectRoles);
  return await saveProjectRoleSettings(input.scope, payload);
}

/** Persist the machine-wide defaults. */
export async function saveGlobalSettings(input: {
  roles: Record<string, RoleBindingInput>;
  ui: UiState;
}): Promise<void> {
  await saveDesktopSettings(globalSettingsPayload(input.roles, input.ui));
}

export type { DesktopSettingsView };
