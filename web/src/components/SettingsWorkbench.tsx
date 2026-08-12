import {
  CheckCircle2,
  CircleAlert,
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
  saveDesktopSettings,
  scanCliInventory,
  ApiError,
} from "../api";
import { agentRoleLabel, errorMessage, orderedRoles } from "../presentation";
import type {
  CliId,
  CliInventory,
  CliProbeResult,
  DesktopSettingsResponse,
  DesktopSettingsView,
  RoleBindingInput,
} from "../types";

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

export function SettingsWorkbench() {
  const [settings, setSettings] = useState<DesktopSettingsView>();
  const [inventory, setInventory] = useState<CliInventory>();
  const [roles, setRoles] = useState<Record<string, RoleBindingInput>>({});
  const [suggested, setSuggested] = useState<Record<string, RoleBindingInput>>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [fromCache, setFromCache] = useState(false);
  const [cacheReason, setCacheReason] = useState<string>();

  const applyResponse = useCallback((response: DesktopSettingsResponse, quiet = false) => {
    setSettings(response.settings);
    setInventory(response.inventory);
    setRoles({ ...response.settings.defaults.roles });
    setSuggested({ ...response.suggestedDefaults });
    setFromCache(response.fromCache);
    setCacheReason(response.reason);
    // Always surface config-change detections; suppress only routine cache hits / first paint noise when quiet.
    if (response.reason === "fingerprint") {
      setMessage("检测到本机 CLI 配置文件已变更，已自动重新检索模型与思考深度");
      return;
    }
    if (quiet) return;
    if (response.reason === "stale") {
      setMessage("缓存已过期，已自动重新检索本机 CLI 配置");
    } else if (response.reason === "miss") {
      setMessage("已完成首次本机 CLI 检索");
    }
  }, []);

  const load = useCallback(async (opts?: { quiet?: boolean; keepVisible?: boolean }) => {
    if (!opts?.keepVisible) setLoading(true);
    setError(undefined);
    try {
      const response = await getDesktopSettings();
      applyResponse(response, opts?.quiet === true);
    } catch (loadError) {
      setError(formatDesktopError(loadError));
    } finally {
      setLoading(false);
    }
  }, [applyResponse]);

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
    const names = orderedRoles([...Object.keys(roles), ...Object.keys(suggested)]);
    return names.length > 0 ? names : BUILT_IN_ROLES;
  }, [roles, suggested]);

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
      const response = await getDesktopSettings();
      applyResponse(response, true);
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
      await saveDesktopSettings({
        defaults: { roles },
        ui: {
          showCliPickerInRunLauncher: uiState.showCliPickerInRunLauncher,
          autoDetectCliConfig: uiState.autoDetectCliConfig !== false,
          autoDetectOnFocus: uiState.autoDetectOnFocus !== false,
        },
      });
      setMessage("全局默认已保存（仅本机，不写进项目仓库）");
      await load({ quiet: true, keepVisible: true });
    } catch (saveError) {
      setError(formatDesktopError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const updateRole = (role: string, patch: Partial<RoleBindingInput>) => {
    setRoles((current) => {
      const base = current[role] ?? { cli: "grok" as CliId, reasoning: "high" };
      const next = { ...base, ...patch };
      const cli = clisById.get(next.cli);
      if (patch.cli && cli) {
        const model = cli.defaultModel ?? cli.models[0]?.id;
        if (model) next.model = model;
        next.reasoning = cli.defaultReasoning
          ?? cli.models[0]?.reasoningOptions?.[0]
          ?? "high";
      }
      return { ...current, [role]: next };
    });
  };

  // 按本机 CLI 检索结果填充推荐默认（仅未保存的界面状态，仍需点「保存默认」）
  const adoptSuggested = () => {
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
        <strong>正在加载全局设置</strong>
      </div>
    );
  }

  return (
    <section className="settings-workbench" aria-label="全局设置">
      <header className="settings-hero">
        <div className="settings-hero-icon"><Settings2 size={22} /></div>
        <div>
          <span className="section-kicker">本机全局</span>
          <h1>Agent CLI 与角色默认</h1>
          <p>
            检索本机 Codex / Grok / Kimi / Claude 的配置与授权状态，设置默认模型与思考深度。
            新建运行时各角色会预填这些默认值；项目 yaml 仍可收紧权限边界。
          </p>
        </div>
        <div className="settings-hero-actions">
          <button type="button" className="button secondary" onClick={() => void rescan()} disabled={scanning || saving}>
            {scanning ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
            <span>{scanning ? "检测中" : "手动检测"}</span>
          </button>
          <button type="button" className="button primary" onClick={() => void save()} disabled={saving || scanning}>
            {saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
            <span>{saving ? "保存中" : "保存默认"}</span>
          </button>
        </div>
      </header>

      {(error || message) && (
        <div className={`settings-banner ${error ? "is-error" : "is-ok"}`} role="status">
          {error ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
          <span>{error ?? message}</span>
        </div>
      )}

      <section className="settings-panel">
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
            监听路径：~/.codex、~/.grok、~/.kimi-code、~/.claude。改完自动/手动选项后请点「保存默认」。
          </p>
        </div>
      </section>

      <section className="settings-panel">
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
      </section>

      <section className="settings-panel">
        <div className="settings-panel-head">
          <ShieldCheck size={18} />
          <div>
            <h2>角色默认映射</h2>
            <small>保存后，新建运行会预填这些选择（仍可在弹窗里改一次）</small>
          </div>
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
        </div>
        <div className="role-default-grid">
          {roleNames.map((role) => {
            const binding = roles[role] ?? { cli: "grok" as CliId, reasoning: "high" };
            const cli = clisById.get(binding.cli);
            const models = cli?.models ?? [];
            const reasoningOptions = (
              models.find((m) => m.id === binding.model)?.reasoningOptions
              ?? cli?.models[0]?.reasoningOptions
              ?? ["low", "medium", "high"]
            );
            return (
              <div key={role} className="role-default-card">
                <strong>{agentRoleLabel(role)}</strong>
                <label>
                  <span>Agent CLI</span>
                  <select
                    value={binding.cli}
                    onChange={(event) => updateRole(role, { cli: event.target.value as CliId })}
                  >
                    {(["codex", "grok", "claude", "kimi"] as CliId[]).map((id) => {
                      const item = clisById.get(id);
                      const disabled = !item?.installed || !item.runtimeSupported;
                      return (
                        <option key={id} value={id} disabled={disabled}>
                          {CLI_LABEL[id]}
                          {!item?.installed ? "（未安装）" : !item.runtimeSupported ? "（暂不可调用）" : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <label>
                  <span>模型</span>
                  <select
                    value={binding.model ?? ""}
                    onChange={(event) => updateRole(role, { model: event.target.value })}
                  >
                    {(models.length > 0 ? models : [{ id: binding.model ?? "default", label: binding.model ?? "default" }]).map((model) => (
                      <option key={model.id} value={model.id}>{model.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>思考深度</span>
                  <select
                    value={binding.reasoning ?? "high"}
                    onChange={(event) => updateRole(role, { reasoning: event.target.value })}
                  >
                    {reasoningOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
        </div>
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
