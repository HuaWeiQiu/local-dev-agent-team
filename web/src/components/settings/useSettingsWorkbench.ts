import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldPreserveRoleEdits } from "../../presentation";
import type {
  CliId,
  CliInventory,
  CliProbeResult,
  DesktopSettingsResponse,
  DesktopSettingsView,
  ProjectRoleSettingsView,
  ProjectScope,
  RoleBindingInput,
} from "../../types";
import { applyRolePatch } from "../RoleBindingEditor";
import {
  loadDesktopSettings,
  loadProjectRoles,
  rescanInventory,
  saveGlobalSettings,
  saveProjectRoles,
} from "./actions";
import {
  cliIndex,
  formatDesktopError,
  inheritedBinding,
  noticeFor,
  projectStateOf,
  roleNamesFor,
  syncRoleBindings,
  uiStateOf,
  type UiState,
} from "./model";
import { orderedRoles } from "../../presentation";

type Pane = "global" | "project";

export interface SettingsWorkbenchModel {
  settings: DesktopSettingsView | undefined;
  inventory: CliInventory | undefined;
  roles: Record<string, RoleBindingInput>;
  projectRoles: Record<string, RoleBindingInput>;
  suggested: Record<string, RoleBindingInput>;
  projectSources: Record<string, "global" | "project">;
  roleNames: string[];
  ui: UiState;
  loading: boolean;
  scanning: boolean;
  saving: boolean;
  message: string | undefined;
  error: string | undefined;
  fromCache: boolean;
  cacheReason: string | undefined;
  patchUi(patch: Partial<DesktopSettingsView["ui"]>): void;
  updateRole(role: string, patch: Partial<RoleBindingInput>): void;
  inheritGlobal(role: string): void;
  adoptSuggested(): void;
  rescan(): Promise<void>;
  save(): Promise<void>;
}

/**
 * Data and actions behind the settings workbench.
 *
 * Kept out of the component so the render function stays a layout: the loading
 * invariant ("a quiet refresh must not overwrite unsaved role edits") lives
 * here, in one place, and is tested without a DOM.
 */
export function useSettingsWorkbench(input: {
  pane: Pane;
  scope: ProjectScope | undefined;
  onSaved: (() => void) | undefined;
}): SettingsWorkbenchModel {
  const { pane, scope, onSaved } = input;
  const [settings, setSettings] = useState<DesktopSettingsView>();
  const [inventory, setInventory] = useState<CliInventory>();
  const [roles, setRoles] = useState<Record<string, RoleBindingInput>>({});
  const [projectRoles, setProjectRoles] = useState<Record<string, RoleBindingInput>>({});
  const [projectSources, setProjectSources] = useState<Record<string, "global" | "project">>({});
  const [suggested, setSuggested] = useState<Record<string, RoleBindingInput>>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [fromCache, setFromCache] = useState(false);
  const [cacheReason, setCacheReason] = useState<string>();
  const rolesDirty = useRef(false);

  const applyProject = useCallback((layered: ProjectRoleSettingsView) => {
    const next = projectStateOf(layered);
    setProjectRoles(next.roles);
    setProjectSources(next.sources);
  }, []);

  const applyResponse = useCallback(
    (response: DesktopSettingsResponse, opts?: { quiet?: boolean }) => {
      const preserve = shouldPreserveRoleEdits(rolesDirty.current, opts);
      applyEnvelope(
        { setSettings, setInventory, setSuggested, setFromCache, setCacheReason, setRoles, setMessage },
        response,
        preserve,
      );
      setMessage(noticeFor(response, opts, preserve));
    },
    [],
  );

  const load = useCallback(
    async (opts?: { quiet?: boolean; keepVisible?: boolean }) => {
      if (!opts?.keepVisible) setLoading(true);
      setError(undefined);
      const preserve = shouldPreserveRoleEdits(rolesDirty.current, opts);
      try {
        const response = await loadDesktopSettings();
        applyResponse(response, opts);
        if (scope && !preserve) await applyProjectOrReport(scope, applyProject, pane, setError);
      } catch (loadError) {
        setError(formatDesktopError(loadError));
      } finally {
        setLoading(false);
      }
    },
    [applyProject, applyResponse, pane, scope],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const ui = uiStateOf(settings);
  useAutoRefresh(load, ui);

  const clisById = useMemo(() => cliIndex(inventory), [inventory]);
  useInventorySync(clisById, setRoles, setMessage, inventory);

  const roleNames = useMemo(
    () => roleNamesFor(roles, projectRoles, suggested, orderedRoles),
    [projectRoles, roles, suggested],
  );

  const markDirty = (): void => {
    rolesDirty.current = true;
  };

  const patchUi = (patch: Partial<DesktopSettingsView["ui"]>): void => {
    setSettings((current) => withUi(current, roles, inventory, ui, patch));
  };

  const updateRole = (role: string, patch: Partial<RoleBindingInput>): void => {
    markDirty();
    if (pane === "project") {
      setProjectRoles((current) => applyRolePatch(current, role, patch, inventory));
      setProjectSources((current) => ({ ...current, [role]: "project" }));
      return;
    }
    setRoles((current) => applyRolePatch(current, role, patch, inventory));
  };

  const inheritGlobal = (role: string): void => {
    markDirty();
    const binding = inheritedBinding(roles[role], projectRoles[role]);
    setProjectRoles((current) => ({ ...current, [role]: binding }));
    setProjectSources((current) => ({ ...current, [role]: "global" }));
  };

  const adoptSuggested = (): void => {
    markDirty();
    setRoles((current) => ({ ...current, ...suggested }));
    setMessage("已填入建议默认，确认后请点「保存默认」");
  };

  const rescan = async (): Promise<void> => {
    await runRescan({
      setScanning,
      setError,
      setMessage,
      setInventory,
      setFromCache,
      setCacheReason,
      applyResponse,
    });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    const outcome = await runSave({
      pane,
      scope,
      roleNames,
      projectSources,
      projectRoles,
      roles,
      ui,
      load,
      applyProject,
    });
    if (outcome.error) {
      setError(outcome.error);
      setSaving(false);
      return;
    }
    setMessage(outcome.message);
    rolesDirty.current = false;
    setSaving(false);
    onSaved?.();
  };

  return {
    settings,
    inventory,
    roles,
    projectRoles,
    suggested,
    projectSources,
    roleNames,
    ui,
    loading,
    scanning,
    saving,
    message,
    error,
    fromCache,
    cacheReason,
    patchUi,
    updateRole,
    inheritGlobal,
    adoptSuggested,
    rescan,
    save,
  };
}

async function applyProjectOrReport(
  scope: ProjectScope,
  applyProject: (layered: ProjectRoleSettingsView) => void,
  pane: Pane,
  setError: (value: string) => void,
): Promise<void> {
  try {
    applyProject(await loadProjectRoles(scope));
  } catch (projectError) {
    if (pane === "project") setError(formatDesktopError(projectError));
  }
}

/** Re-check the CLI fingerprint every 30s, and on focus when the user allows it. */
function useAutoRefresh(
  load: (opts?: { quiet?: boolean; keepVisible?: boolean }) => Promise<void>,
  ui: UiState,
): void {
  const enabled = ui.autoDetectCliConfig !== false;
  const onFocus = ui.autoDetectOnFocus !== false;
  useEffect(() => {
    if (!enabled) return;
    const onVisible = (): void => {
      if (!onFocus || document.visibilityState !== "visible") return;
      void load({ quiet: true, keepVisible: true });
    };
    const onInterval = (): void => {
      if (document.visibilityState !== "visible") return;
      void load({ quiet: true, keepVisible: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(onInterval, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, [enabled, onFocus, load]);
}

/** Snap roles back onto the models the freshly detected CLIs still offer. */
function useInventorySync(
  clisById: Map<CliId, CliProbeResult>,
  setRoles: (updater: (current: Record<string, RoleBindingInput>) => Record<string, RoleBindingInput>) => void,
  setMessage: (updater: (previous: string | undefined) => string | undefined) => void,
  inventory: CliInventory | undefined,
): void {
  useEffect(() => {
    if (!inventory) return;
    setRoles((current) => {
      const synced = syncRoleBindings(current, clisById);
      if (synced.changed) {
        setMessage((previous) => previous ?? "部分角色的模型/思考深度已随 CLI 配置更新自动校正");
      }
      return synced.roles;
    });
  }, [clisById, inventory, setMessage, setRoles]);
}

export function withUi(
  current: DesktopSettingsView | undefined,
  roles: Record<string, RoleBindingInput>,
  inventory: CliInventory | undefined,
  ui: UiState,
  patch: Partial<DesktopSettingsView["ui"]>,
): DesktopSettingsView {
  if (!current) {
    return {
      version: 1,
      defaults: { roles },
      ui: { ...ui, ...patch },
      inventoryCachedAt: inventory?.scannedAt ?? null,
    };
  }
  return { ...current, ui: { ...current.ui, ...patch } };
}

interface RescanHost {
  setScanning(value: boolean): void;
  setError(value: string | undefined): void;
  setMessage(value: string | undefined): void;
  setInventory(value: CliInventory): void;
  setFromCache(value: boolean): void;
  setCacheReason(value: string | undefined): void;
  applyResponse(response: DesktopSettingsResponse, opts?: { quiet?: boolean }): void;
}

/** Manual re-detection: it always wins over a dirty editor (explicit user intent). */
async function runRescan(host: RescanHost): Promise<void> {
  host.setScanning(true);
  host.setError(undefined);
  host.setMessage(undefined);
  try {
    const result = await rescanInventory();
    host.setInventory(result.inventory);
    host.setFromCache(false);
    host.setCacheReason(result.reason);
    host.applyResponse(result.settings, { quiet: true });
    host.setMessage("已强制重新检索本机 CLI 配置");
  } catch (scanError) {
    host.setError(formatDesktopError(scanError));
  } finally {
    host.setScanning(false);
  }
}

interface SaveInput {
  pane: Pane;
  scope: ProjectScope | undefined;
  roleNames: string[];
  projectSources: Record<string, "global" | "project">;
  projectRoles: Record<string, RoleBindingInput>;
  roles: Record<string, RoleBindingInput>;
  ui: UiState;
  load(opts?: { quiet?: boolean; keepVisible?: boolean }): Promise<void>;
  applyProject(layered: ProjectRoleSettingsView): void;
}

/** Persist the pane's edits and report what the operator should see. */
async function runSave(input: SaveInput): Promise<{ message?: string; error?: string }> {
  try {
    if (input.pane === "project") {
      if (!input.scope) throw new Error("当前没有选中项目");
      input.applyProject(
        await saveProjectRoles({
          scope: input.scope,
          roleNames: input.roleNames,
          sources: input.projectSources,
          projectRoles: input.projectRoles,
        }),
      );
      return { message: "项目角色已保存（只覆盖本项目；未覆盖的角色继续用全局）" };
    }
    await saveGlobalSettings({ roles: input.roles, ui: input.ui });
    await input.load({ quiet: true, keepVisible: true });
    return { message: "全局默认已保存（仅本机，不写进项目仓库）" };
  } catch (saveError) {
    return { error: formatDesktopError(saveError) };
  }
}

interface EnvelopeHost {
  setSettings(value: DesktopSettingsView): void;
  setInventory(value: CliInventory): void;
  setSuggested(value: Record<string, RoleBindingInput>): void;
  setFromCache(value: boolean): void;
  setCacheReason(value: string | undefined): void;
  setRoles(value: Record<string, RoleBindingInput>): void;
  setMessage(value: string | undefined): void;
}

/** Apply a settings envelope, keeping unsaved role edits when asked to. */
function applyEnvelope(
  host: EnvelopeHost,
  response: DesktopSettingsResponse,
  preserveRoleEdits: boolean,
): void {
  host.setSettings(response.settings);
  host.setInventory(response.inventory);
  host.setSuggested({ ...response.suggestedDefaults });
  host.setFromCache(response.fromCache);
  host.setCacheReason(response.reason);
  if (!preserveRoleEdits) host.setRoles({ ...response.settings.defaults.roles });
}
