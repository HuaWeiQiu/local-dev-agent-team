import {
  CheckCircle2,
  CircleAlert,
  FolderCog,
  LoaderCircle,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getDesktopSettings,
  getProjectRoleSettings,
  saveDesktopSettings,
  saveProjectRoleSettings,
  scanCliInventory,
  ApiError,
} from "../api";
import { errorMessage, orderedRoles, shouldPreserveRoleEdits } from "../presentation";
import type {
  CliId,
  CliInventory,
  CliProbeResult,
  DesktopSettingsResponse,
  DesktopSettingsView,
  ProjectRoleSettingsView,
  ProjectScope,
  RoleBindingInput,
} from "../types";
import { applyRolePatch, RoleBindingEditor } from "./RoleBindingEditor";

const BUILT_IN_ROLES = [
  "orchestrator",
  "architect",
  "researcher",
  "worker",
  "reviewer",
  "tester",
];
const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export function SettingsWorkbench({
  pane = "global",
  scope,
  projectName,
  onOpenProject,
  onOpenGlobal,
  onSaved,
}: {
  pane?: "global" | "project";
  scope?: ProjectScope;
  projectName?: string;
  onOpenProject?(): void;
  onOpenGlobal?(): void;
  onSaved?(): void;
}) {
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
  // 脏标记：用户改了「全局角色默认」/「项目角色」但尚未保存（或放弃）时为 true。
  // 自动刷新（quiet+keepVisible）看到脏标记时不得覆盖 roles/projectRoles，只提示保留。
  const [rolesDirty, setRolesDirty] = useState(false);

  const applyProject = useCallback((layered: ProjectRoleSettingsView) => {
    setProjectRoles({ ...layered.effective });
    setProjectSources({ ...layered.sources });
  }, []);

  const applyResponse = useCallback((response: DesktopSettingsResponse, opts?: { quiet?: boolean; keepVisible?: boolean }) => {
    setSettings(response.settings);
    setInventory(response.inventory);
    // 不变量：roles 只在非脏或用户明确触发（手动检测 / 保存回读）时被服务端默认覆盖；
    // 自动刷新（quiet+keepVisible）遇脏则跳过覆盖，见 shouldPreserveRoleEdits。
    const preserveRoleEdits = shouldPreserveRoleEdits(rolesDirty, opts);
    if (!preserveRoleEdits) {
      setRoles({ ...response.settings.defaults.roles });
    }
    setSuggested({ ...response.suggestedDefaults });
    setFromCache(response.fromCache);
    setCacheReason(response.reason);
    if (preserveRoleEdits) {
      // 自动刷新跳过了 roles/projectRoles 覆盖：其余字段（inventory/settings.ui/suggested）已照常刷新。
      setMessage("检测到未保存的角色修改，已保留；自动刷新未覆盖它们");
      return;
    }
    // Always surface config-change detections; suppress only routine cache hits / first paint noise when quiet.
    if (response.reason === "fingerprint") {
      setMessage("检测到本机 CLI 配置文件已变更，已自动重新检索模型与思考深度");
      return;
    }
    if (opts?.quiet) return;
    if (response.reason === "stale") {
      setMessage("缓存已过期，已自动重新检索本机 CLI 配置");
    } else if (response.reason === "miss") {
      setMessage("已完成首次本机 CLI 检索");
    }
  }, [rolesDirty]);

  const load = useCallback(async (opts?: { quiet?: boolean; keepVisible?: boolean }) => {
    if (!opts?.keepVisible) setLoading(true);
    setError(undefined);
    // 自动刷新（quiet+keepVisible）在脏状态下同时保留项目角色的本地编辑。
    const preserveRoleEdits = shouldPreserveRoleEdits(rolesDirty, opts);
    try {
      const response = await getDesktopSettings();
      applyResponse(response, opts);
      if (scope) {
        try {
          const layered = await getProjectRoleSettings(scope);
          if (!preserveRoleEdits) applyProject(layered);
        } catch (projectError) {
          if (pane === "project") setError(formatDesktopError(projectError));
        }
      }
    } catch (loadError) {
      setError(formatDesktopError(loadError));
    } finally {
      setLoading(false);
    }
  }, [applyProject, applyResponse, pane, rolesDirty, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const autoDetectEnabled = settings?.ui.autoDetectCliConfig !== false;
  const autoDetectOnFocus = settings?.ui.autoDetectOnFocus !== false;

  // Auto re-check when user returns to the tab / window, or every 30s while settings is open.
  // Server only re-scans when config mtime fingerprint changes — cheap hit path uses cache.
  // Manual detect button always works regardless of these toggles.
  useEffect(() => {
    if (!autoDetectEnabled) return;
    const onVisible = () => {
      if (!autoDetectOnFocus) return;
      if (document.visibilityState === "visible") {
        void load({ quiet: true, keepVisible: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load({ quiet: true, keepVisible: true });
      }
    }, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, [autoDetectEnabled, autoDetectOnFocus, load]);

  const clisById = useMemo(() => {
    const map = new Map<CliId, CliProbeResult>();
    for (const cli of inventory?.clis ?? []) map.set(cli.id, cli);
    return map;
  }, [inventory]);

  // 已知角色保持既定顺序，项目自定义角色追加在后
  const roleNames = useMemo(() => {
    const names = orderedRoles([
      ...Object.keys(roles),
      ...Object.keys(projectRoles),
      ...Object.keys(suggested),
    ]);
    return names.length > 0 ? names : BUILT_IN_ROLES;
  }, [projectRoles, roles, suggested]);

  // If inventory updates and a selected model/reasoning disappeared, snap to CLI defaults.
  useEffect(() => {
    if (!inventory) return;
    setRoles((current) => {
      let anyChanged = false;
      const next: Record<string, RoleBindingInput> = { ...current };
      for (const [role, binding] of Object.entries(current)) {
        const cli = clisById.get(binding.cli);
        if (!cli) continue;
        let model = binding.model;
        let reasoning = binding.reasoning;
        let roleChanged = false;
        if (model && cli.models.length > 0 && !cli.models.some((item) => item.id === model)) {
          model = cli.defaultModel ?? cli.models[0]?.id;
          roleChanged = true;
        }
        const modelInfo = cli.models.find((item) => item.id === (model ?? binding.model));
        const options = modelInfo?.reasoningOptions ?? [];
        if (reasoning && options.length > 0 && !options.includes(reasoning)) {
          reasoning = cli.defaultReasoning ?? options[0] ?? "high";
          roleChanged = true;
        }
        if (roleChanged) {
          anyChanged = true;
          next[role] = {
            cli: binding.cli,
            ...(model ? { model } : {}),
            ...(reasoning ? { reasoning } : {}),
          };
        }
      }
      if (anyChanged) {
        setMessage((prev) => prev ?? "部分角色的模型/思考深度已随 CLI 配置更新自动校正");
      }
      return anyChanged ? next : current;
    });
  }, [clisById, inventory]);

  const rescan = async () => {
    setScanning(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await scanCliInventory();
      setInventory(result.inventory);
      setFromCache(false);
      setCacheReason(result.reason ?? "refresh");
      setMessage("已强制重新检索本机 CLI 配置");
      // refresh settings envelope for cache timestamp + sanitized defaults
      // 手动「重新检测」是用户明确意图：即使有脏编辑也按最新服务端默认覆盖。
      const response = await getDesktopSettings();
      applyResponse(response, { quiet: true });
      setMessage("已强制重新检索本机 CLI 配置");
    } catch (scanError) {
      setError(formatDesktopError(scanError));
    } finally {
      setScanning(false);
    }
  };

  const uiState = settings?.ui ?? {
    showCliPickerInRunLauncher: true,
    autoDetectCliConfig: true,
    autoDetectOnFocus: true,
  };

  const patchUi = (patch: Partial<DesktopSettingsView["ui"]>) => {
    setSettings((current) => {
      if (!current) {
        return {
          version: 1,
          defaults: { roles },
          ui: { ...uiState, ...patch },
          inventoryCachedAt: inventory?.scannedAt ?? null,
        };
      }
      return {
        ...current,
        ui: { ...current.ui, ...patch },
      };
    });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      if (pane === "project") {
        if (!scope) throw new Error("当前没有选中项目");
        const payload: Record<string, RoleBindingInput | null> = {};
        for (const role of roleNames) {
          payload[role] = projectSources[role] === "project" ? projectRoles[role] ?? null : null;
        }
        applyProject(await saveProjectRoleSettings(scope, payload));
        setRolesDirty(false);
        setMessage("项目角色已保存（只覆盖本项目；未覆盖的角色继续用全局）");
      } else {
        await saveDesktopSettings({
          defaults: { roles },
          ui: {
            showCliPickerInRunLauncher: uiState.showCliPickerInRunLauncher,
            autoDetectCliConfig: uiState.autoDetectCliConfig !== false,
            autoDetectOnFocus: uiState.autoDetectOnFocus !== false,
          },
        });
        // 保存成功后清脏，回读刷新才按新保存的默认覆盖（不会回滚用户刚才的保存）。
        setRolesDirty(false);
        setMessage("全局默认已保存（仅本机，不写进项目仓库）");
        await load({ quiet: true, keepVisible: true });
      }
      onSaved?.();
    } catch (saveError) {
      setError(formatDesktopError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const updateRole = (role: string, patch: Partial<RoleBindingInput>) => {
    setRolesDirty(true);
    if (pane === "project") {
      setProjectRoles((current) => applyRolePatch(current, role, patch, inventory));
      setProjectSources((current) => ({ ...current, [role]: "project" }));
      return;
    }
    setRoles((current) => applyRolePatch(current, role, patch, inventory));
  };

  const inheritGlobal = (role: string) => {
    setRolesDirty(true);
    setProjectRoles((current) => ({
      ...current,
      [role]: roles[role] ?? current[role] ?? { cli: "grok" as CliId, reasoning: "high" },
    }));
    setProjectSources((current) => ({ ...current, [role]: "global" }));
  };

  // 按本机 CLI 检索结果填充推荐默认（仅未保存的界面状态，仍需点「保存默认」）
  const adoptSuggested = () => {
    setRolesDirty(true);
    setRoles((current) => {
      const next = { ...current };
      for (const [role, binding] of Object.entries(suggested)) {
        next[role] = { ...binding };
      }
      return next;
    });
    setMessage("已填入建议默认，确认后请点「保存默认」");
  };

  if (loading) {
    return (
      <div className="settings-workbench settings-loading">
        <LoaderCircle className="spin" size={28} />
        <strong>{pane === "project" ? "正在加载项目设置" : "正在加载全局设置"}</strong>
      </div>
    );
  }

  const isProject = pane === "project";

  return (
    <section className="settings-workbench" aria-label={isProject ? "项目设置" : "全局设置"}>
      <header className="settings-hero">
        <div className="settings-hero-icon">{isProject ? <FolderCog size={22} /> : <Settings2 size={22} />}</div>
        <div>
          <span className="section-kicker">{isProject ? `当前项目${projectName ? ` · ${projectName}` : ""}` : "本机全局"}</span>
          <h1>{isProject ? "项目角色覆盖" : "Agent CLI 与角色默认"}</h1>
          <p>
            {isProject
              ? "只改当前项目。某个角色没单独设置时，自动用全局默认；保存后新建运行和重试都会按合并结果选 CLI。"
              : "检索本机 Codex / Grok / Kimi / Claude 的配置与授权状态，设置默认模型与思考深度。项目没有单独覆盖的角色会用这里的值。"}
          </p>
        </div>
        <div className="settings-hero-actions">
          {!isProject && (
            <button type="button" className="button secondary" onClick={() => void rescan()} disabled={scanning || saving}>
              {scanning ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
              <span>{scanning ? "检测中" : "手动检测"}</span>
            </button>
          )}
          {isProject && onOpenGlobal && (
            <button type="button" className="button secondary" onClick={onOpenGlobal}>
              <Settings2 size={16} />
              <span>全局设置</span>
            </button>
          )}
          {!isProject && onOpenProject && (
            <button type="button" className="button secondary" onClick={onOpenProject} disabled={!scope}>
              <FolderCog size={16} />
              <span>项目设置</span>
            </button>
          )}
          <button type="button" className="button primary" onClick={() => void save()} disabled={saving || scanning}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
            <span>{saving ? "保存中" : isProject ? "保存项目" : "保存全局"}</span>
          </button>
        </div>
      </header>

      <div className="settings-layer-tabs" role="tablist" aria-label="设置范围">
        <button
          type="button"
          role="tab"
          aria-selected={!isProject}
          className={!isProject ? "is-active" : ""}
          onClick={() => onOpenGlobal?.()}
          disabled={!isProject && !onOpenGlobal}
        >
          全局
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isProject}
          className={isProject ? "is-active" : ""}
          onClick={() => onOpenProject?.()}
          disabled={!scope || (isProject && !onOpenProject)}
        >
          项目
        </button>
      </div>

      {(error || message) && (
        <div className={`settings-banner ${error ? "is-error" : "is-ok"}`} role="status">
          {error ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
          <span>{error ?? message}</span>
        </div>
      )}

      {!isProject && <section className="settings-panel">
        <div className="settings-panel-head">
          <RefreshCw size={18} />
          <div>
            <h2>CLI 配置检测</h2>
            <small>自动检测可关；手动检测随时可用，强制扫本机配置</small>
          </div>
        </div>
        <div className="detect-options">
          <label className="detect-option">
            <input
              type="checkbox"
              checked={uiState.autoDetectCliConfig !== false}
              onChange={(event) => patchUi({ autoDetectCliConfig: event.target.checked })}
              disabled={saving || scanning}
            />
            <span>
              <strong>自动检测</strong>
              <small>设置页打开时每 30 秒检查配置指纹；变更则刷新模型/思考深度</small>
            </span>
          </label>
          <label className="detect-option">
            <input
              type="checkbox"
              checked={uiState.autoDetectOnFocus !== false}
              onChange={(event) => patchUi({ autoDetectOnFocus: event.target.checked })}
              disabled={saving || scanning || uiState.autoDetectCliConfig === false}
            />
            <span>
              <strong>回到窗口时检测</strong>
              <small>切回 Agent Team 时检查 ~/.codex 等配置是否改过</small>
            </span>
          </label>
          <label className="detect-option">
            <input
              type="checkbox"
              checked={uiState.showCliPickerInRunLauncher !== false}
              onChange={(event) => patchUi({ showCliPickerInRunLauncher: event.target.checked })}
              disabled={saving || scanning}
            />
            <span>
              <strong>新建运行时可选择 CLI</strong>
              <small>关闭后新建运行直接使用项目 profile 默认，角色区只读展示当前绑定</small>
            </span>
          </label>
          <div className="detect-manual-row">
            <div>
              <strong>手动检测</strong>
              <small>立即强制重扫本机 Codex / Grok / Kimi / Claude，不依赖自动开关</small>
            </div>
            <button type="button" className="button secondary" onClick={() => void rescan()} disabled={scanning || saving}>
              {scanning ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
              <span>{scanning ? "检测中…" : "立即手动检测"}</span>
            </button>
          </div>
          <p className="settings-detect-hint">
            监听路径：~/.codex、~/.grok、~/.kimi-code、~/.claude。改完自动/手动选项后请点「保存全局」。
          </p>
        </div>
      </section>}

      {!isProject && <section className="settings-panel">
        <div className="settings-panel-head">
          <Terminal size={18} />
          <div>
            <h2>本机 CLI 清单</h2>
            <small>
              {inventory
                ? `${cacheSourceLabel(fromCache, cacheReason)} · 扫描于 ${new Date(inventory.scannedAt).toLocaleString("zh-CN")}`
                : "尚未扫描"}
            </small>
          </div>
          <button
            type="button"
            className="button secondary settings-inline-detect"
            onClick={() => void rescan()}
            disabled={scanning || saving}
          >
            {scanning ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            <span>{scanning ? "检测中" : "手动检测"}</span>
          </button>
        </div>
        <div className="cli-card-grid">
          {(inventory?.clis ?? []).map((cli) => (
            <article key={cli.id} className={`cli-card ${cli.installed ? "is-installed" : "is-missing"}`}>
              <header>
                <strong>{CLI_LABEL[cli.id]}</strong>
                <span className={`cli-badge is-${cli.auth.status}`}>
                  {authLabel(cli.auth.status)}
                </span>
              </header>
              <dl>
                <div><dt>安装</dt><dd>{cli.installed ? "已安装" : "未找到"}</dd></div>
                {cli.version && <div><dt>版本</dt><dd title={cli.version}>{cli.version}</dd></div>}
                {cli.binary && <div><dt>路径</dt><dd className="mono" title={cli.binary}>{shortPath(cli.binary)}</dd></div>}
                <div><dt>默认模型</dt><dd>{cli.defaultModel ?? "—"}</dd></div>
                <div><dt>思考深度</dt><dd>{cli.defaultReasoning ?? "—"}</dd></div>
                <div><dt>运行时</dt><dd>{cli.runtimeSupported ? "可调用" : "仅展示"}</dd></div>
                {cli.auth.detail && <div><dt>授权说明</dt><dd>{cli.auth.detail}</dd></div>}
              </dl>
              {cli.models.length > 0 && (
                <div className="cli-models">
                  {cli.models.slice(0, 6).map((model) => (
                    <code key={model.id}>{model.label}</code>
                  ))}
                  {cli.models.length > 6 && <span>+{cli.models.length - 6}</span>}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>}

      <section className="settings-panel">
        <div className="settings-panel-head">
          <ShieldCheck size={18} />
          <div>
            <h2>{isProject ? "项目角色" : "全局角色默认"}</h2>
            <small>
              {isProject
                ? "改过的角色只对本项目生效；点「恢复全局」后该角色重新跟全局走"
                : "保存后，没有项目覆盖的角色会用这些值；新建运行仍可在弹窗里改一次"}
            </small>
          </div>
          {!isProject && (
            <button
              type="button"
              className="button secondary settings-inline-detect"
              onClick={adoptSuggested}
              disabled={saving || scanning || Object.keys(suggested).length === 0}
              title="按本机 CLI 检索结果填充推荐的默认模型与思考深度"
            >
              <Sparkles size={14} />
              <span>采用建议默认</span>
            </button>
          )}
        </div>
        <RoleBindingEditor
          roles={isProject ? projectRoles : roles}
          roleNames={roleNames}
          {...(inventory ? { inventory } : {})}
          disabled={saving || scanning}
          {...(isProject ? { sources: projectSources, onClear: inheritGlobal } : {})}
          onChange={updateRole}
        />
      </section>
    </section>
  );
}

function authLabel(status: CliProbeResult["auth"]["status"]): string {
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

function shortPath(value: string): string {
  if (value.length <= 42) return value;
  return `…${value.slice(-40)}`;
}

function formatDesktopError(error: unknown): string {
  if (error instanceof ApiError && error.code === "SESSION_REQUIRED") {
    return "需要桌面控制会话。请从 Agent Team 桌面端打开，或带 session 的本机服务。";
  }
  return errorMessage(error);
}

function cacheSourceLabel(fromCache: boolean, reason: string | undefined): string {
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
