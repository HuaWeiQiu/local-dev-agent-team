import { errorMessage } from "../../presentation";
import { ApiError } from "../../api";
import type {
  CliId,
  CliInventory,
  CliProbeResult,
  DesktopSettingsResponse,
  DesktopSettingsView,
  ProjectRoleSettingsView,
  RoleBindingInput,
} from "../../types";

/** Roles every project has, used when the inventory has not answered yet. */
export const BUILT_IN_ROLES = [
  "orchestrator",
  "architect",
  "researcher",
  "worker",
  "reviewer",
  "tester",
];

export const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export type UiState = DesktopSettingsView["ui"];

export const DEFAULT_UI_STATE: UiState = {
  showCliPickerInRunLauncher: true,
  autoDetectCliConfig: true,
  autoDetectOnFocus: true,
};

export function uiStateOf(settings: DesktopSettingsView | undefined): UiState {
  return settings?.ui ?? { ...DEFAULT_UI_STATE };
}

/**
 * Snap role bindings back onto values the installed CLIs still offer.
 * Returns the same object when nothing changed, so React state stays stable.
 */
export function syncRoleBindings(
  current: Record<string, RoleBindingInput>,
  clisById: Map<CliId, CliProbeResult>,
): { roles: Record<string, RoleBindingInput>; changed: boolean } {
  const next: Record<string, RoleBindingInput> = { ...current };
  let changed = false;
  for (const [role, binding] of Object.entries(current)) {
    const cli = clisById.get(binding.cli);
    if (!cli) continue;
    const synced = syncBinding(binding, cli);
    if (!synced) continue;
    changed = true;
    next[role] = synced;
  }
  return changed ? { roles: next, changed } : { roles: current, changed };
}

/** The corrected binding, or undefined when the current one is still valid. */
function syncBinding(
  binding: RoleBindingInput,
  cli: CliProbeResult,
): RoleBindingInput | undefined {
  const model = syncModel(binding.model, cli);
  const reasoning = syncReasoning(binding.reasoning, model, cli);
  if (model === binding.model && reasoning === binding.reasoning) return undefined;
  return {
    cli: binding.cli,
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function syncModel(model: string | undefined, cli: CliProbeResult): string | undefined {
  if (!model || cli.models.length === 0) return model;
  if (cli.models.some((item) => item.id === model)) return model;
  return cli.defaultModel ?? cli.models[0]?.id;
}

function syncReasoning(
  reasoning: string | undefined,
  model: string | undefined,
  cli: CliProbeResult,
): string | undefined {
  if (!reasoning) return reasoning;
  const modelInfo = cli.models.find((item) => item.id === model);
  const options = modelInfo?.reasoningOptions ?? [];
  if (options.length === 0 || options.includes(reasoning)) return reasoning;
  return cli.defaultReasoning ?? options[0] ?? "high";
}

/** Payload for saving project overrides: a role the project does not own is cleared. */
export function projectRolePayload(
  roleNames: string[],
  sources: Record<string, "global" | "project">,
  projectRoles: Record<string, RoleBindingInput>,
): Record<string, RoleBindingInput | null> {
  const payload: Record<string, RoleBindingInput | null> = {};
  for (const role of roleNames) {
    payload[role] = sources[role] === "project" ? projectRoles[role] ?? null : null;
  }
  return payload;
}

/** Payload for saving the machine-wide defaults. */
export function globalSettingsPayload(
  roles: Record<string, RoleBindingInput>,
  ui: UiState,
): {
  defaults: { roles: Record<string, RoleBindingInput> };
  ui: DesktopSettingsView["ui"];
} {
  return {
    defaults: { roles },
    ui: {
      showCliPickerInRunLauncher: ui.showCliPickerInRunLauncher,
      autoDetectCliConfig: ui.autoDetectCliConfig !== false,
      autoDetectOnFocus: ui.autoDetectOnFocus !== false,
    },
  };
}

export function authTone(
  status: CliProbeResult["auth"]["status"],
): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "present":
      return "success";
    case "missing":
      return "warning";
    case "invalid":
      return "danger";
    default:
      return "neutral";
  }
}

export function authLabel(status: CliProbeResult["auth"]["status"]): string {
  switch (status) {
    case "present":
      return "已配置授权";
    case "missing":
      return "未授权";
    case "invalid":
      return "授权无效";
    default:
      return "未知";
  }
}

export function shortPath(value: string): string {
  if (value.length <= 42) return value;
  return `…${value.slice(-40)}`;
}

export function formatDesktopError(error: unknown): string {
  if (error instanceof ApiError && error.code === "SESSION_REQUIRED") {
    return "需要桌面控制会话。请从 Agent Team 桌面端打开，或带 session 的本机服务。";
  }
  return errorMessage(error);
}

export function cacheSourceLabel(fromCache: boolean, reason: string | undefined): string {
  if (fromCache || reason === "hit") return "缓存（配置未变）";
  switch (reason) {
    case "fingerprint":
      return "已自动更新（检测到配置变更）";
    case "stale":
      return "已自动更新（缓存过期）";
    case "refresh":
      return "强制检索";
    case "miss":
      return "首次检索";
    default:
      return fromCache ? "缓存" : "实时";
  }
}

/** Role names to render: known roles in canonical order, project-only roles last. */
export function roleNamesFor(
  roles: Record<string, RoleBindingInput>,
  projectRoles: Record<string, RoleBindingInput>,
  suggested: Record<string, RoleBindingInput>,
  ordered: (names: string[]) => string[],
): string[] {
  const names = ordered([
    ...Object.keys(roles),
    ...Object.keys(projectRoles),
    ...Object.keys(suggested),
  ]);
  return names.length > 0 ? names : BUILT_IN_ROLES;
}

/** Merge a layered project response into the editor state. */
export function projectStateOf(layered: ProjectRoleSettingsView): {
  roles: Record<string, RoleBindingInput>;
  sources: Record<string, "global" | "project">;
} {
  return { roles: { ...layered.effective }, sources: { ...layered.sources } };
}

/** Index the probe results by CLI id. */
export function cliIndex(inventory: CliInventory | undefined): Map<CliId, CliProbeResult> {
  const map = new Map<CliId, CliProbeResult>();
  for (const cli of inventory?.clis ?? []) map.set(cli.id, cli);
  return map;
}

/** Operator-facing notice for a settings response; undefined means stay quiet. */
export function noticeFor(
  response: DesktopSettingsResponse,
  opts: { quiet?: boolean } | undefined,
  preserveRoleEdits: boolean,
): string | undefined {
  if (preserveRoleEdits) {
    return "检测到未保存的角色修改，已保留；自动刷新未覆盖它们";
  }
  if (response.reason === "fingerprint") {
    return "检测到本机 CLI 配置文件已变更，已自动重新检索模型与思考深度";
  }
  if (opts?.quiet) return undefined;
  if (response.reason === "stale") return "缓存已过期，已自动重新检索本机 CLI 配置";
  if (response.reason === "miss") return "已完成首次本机 CLI 检索";
  return undefined;
}

/** Binding to use when a project role is reset back to the global default. */
export function inheritedBinding(
  globalBinding: RoleBindingInput | undefined,
  currentBinding: RoleBindingInput | undefined,
): RoleBindingInput {
  return globalBinding ?? currentBinding ?? { cli: "grok", reasoning: "high" };
}
