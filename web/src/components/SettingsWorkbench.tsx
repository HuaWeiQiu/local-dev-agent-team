import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getDesktopSettings,
  saveDesktopSettings,
  scanCliInventory,
  ApiError,
} from "../api";
import { agentRoleLabel, errorMessage } from "../presentation";
import type {
  CliId,
  CliInventory,
  CliProbeResult,
  DesktopSettingsView,
  RoleBindingInput,
} from "../types";

const ROLE_ORDER = ["orchestrator", "architect", "worker", "reviewer", "tester"] as const;
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
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [fromCache, setFromCache] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await getDesktopSettings();
      setSettings(response.settings);
      setInventory(response.inventory);
      setRoles({ ...response.settings.defaults.roles });
      setFromCache(response.fromCache);
    } catch (loadError) {
      setError(formatDesktopError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clisById = useMemo(() => {
    const map = new Map<CliId, CliProbeResult>();
    for (const cli of inventory?.clis ?? []) map.set(cli.id, cli);
    return map;
  }, [inventory]);

  const rescan = async () => {
    setScanning(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await scanCliInventory();
      setInventory(result.inventory);
      setFromCache(false);
      setMessage("已重新检索本机 CLI 配置");
      // refresh settings envelope for cache timestamp
      const response = await getDesktopSettings();
      setSettings(response.settings);
    } catch (scanError) {
      setError(formatDesktopError(scanError));
    } finally {
      setScanning(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await saveDesktopSettings({
        defaults: { roles },
        ui: settings?.ui ?? { showCliPickerInRunLauncher: true },
      });
      setMessage("全局默认已保存（仅本机，不写进项目仓库）");
      await load();
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
            <span>{scanning ? "检索中" : "重新检索"}</span>
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
          <Terminal size={18} />
          <div>
            <h2>本机 CLI 清单</h2>
            <small>
              {inventory
                ? `${fromCache ? "缓存" : "实时"} · 扫描于 ${new Date(inventory.scannedAt).toLocaleString("zh-CN")}`
                : "尚未扫描"}
            </small>
          </div>
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
                <div><dt>运行时</dt><dd>{cli.runtimeSupported ? "可调用" : "仅展示（适配未接通）"}</dd></div>
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
        </div>
        <div className="role-default-grid">
          {ROLE_ORDER.map((role) => {
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
