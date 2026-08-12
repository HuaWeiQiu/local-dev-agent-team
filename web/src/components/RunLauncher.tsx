import { ChevronDown, Play, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  agentRoleLabel,
  morphologySummary,
  profileDisplayName,
  strategyDisplayName,
} from "../presentation";
import type {
  CliId,
  CliInventory,
  PublicConfig,
  RoleBindingInput,
  StartRunInput,
} from "../types";

interface RunLauncherProps {
  open: boolean;
  config: PublicConfig;
  initialStrategy?: string;
  busy: boolean;
  error: string | undefined;
  /** Global defaults + inventory for CLI picker */
  roleDefaults?: Record<string, RoleBindingInput>;
  inventory?: CliInventory;
  onClose(): void;
  onSubmit(input: StartRunInput): Promise<void>;
}

const ROLE_ORDER = [
  "orchestrator",
  "architect",
  "researcher",
  "worker",
  "reviewer",
  "tester",
] as const;
const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export function RunLauncher({
  open,
  config,
  initialStrategy,
  busy,
  error,
  roleDefaults,
  inventory,
  onClose,
  onSubmit,
}: RunLauncherProps) {
  const [goal, setGoal] = useState("");
  const [strategy, setStrategy] = useState(config.strategies.default);
  const [advanced, setAdvanced] = useState(true);
  const [bindings, setBindings] = useState<Record<string, RoleBindingInput>>({});
  const [useCliPicker, setUseCliPicker] = useState(true);

  const clisById = useMemo(() => {
    const map = new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));
    return map;
  }, [inventory]);

  useEffect(() => {
    if (!open) return;
    setStrategy(
      initialStrategy && config.strategies.definitions[initialStrategy]
        ? initialStrategy
        : config.strategies.default,
    );
    const multiProfile = Object.values(config.roles).some((policy) => policy.allowedProfiles.length > 1);
    setAdvanced(true);
    const next: Record<string, RoleBindingInput> = {};
    for (const role of ROLE_ORDER) {
      if (!config.roles[role]) continue;
      next[role] = roleDefaults?.[role] ?? {
        cli: "grok",
        model: "grok",
        reasoning: "high",
      };
    }
    setBindings(next);
    setUseCliPicker(Boolean(inventory && inventory.clis.some((c) => c.installed && c.runtimeSupported)));
    void multiProfile;
  }, [config.roles, config.strategies.default, config.strategies.definitions, initialStrategy, inventory, open, roleDefaults]);

  if (!open) {
    return null;
  }

  const strategyDefinition = config.strategies.definitions[strategy];

  const updateBinding = (role: string, patch: Partial<RoleBindingInput>) => {
    setBindings((current) => {
      const base = current[role] ?? { cli: "grok" as CliId, reasoning: "high" };
      const next = { ...base, ...patch };
      if (patch.cli) {
        const cli = clisById.get(patch.cli);
        const model = cli?.defaultModel ?? cli?.models[0]?.id;
        const reasoning = cli?.defaultReasoning
          ?? cli?.models[0]?.reasoningOptions?.[0]
          ?? next.reasoning
          ?? "high";
        if (model) next.model = model;
        next.reasoning = reasoning;
      }
      return { ...current, [role]: next };
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) return;

    const roleBindings = useCliPicker
      ? Object.fromEntries(
          Object.entries(bindings).filter(([role]) => config.roles[role]),
        )
      : undefined;

    await onSubmit({
      goal: trimmedGoal,
      ...(strategy !== "legacy" ? { strategy } : {}),
      profileOverrides: {},
      ...(roleBindings && Object.keys(roleBindings).length > 0 ? { roleBindings } : {}),
    });
    setGoal("");
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="run-launcher" role="dialog" aria-modal="true" aria-labelledby="run-launcher-title">
        <header>
          <div>
            <span className="section-kicker">新建运行</span>
            <h2 id="run-launcher-title">启动 Agent 团队</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="field-label" htmlFor="run-goal">目标</label>
          <textarea
            id="run-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：为订单模块增加幂等退款接口，并补齐测试"
            rows={4}
            autoFocus
            required
          />

          <fieldset className="strategy-fieldset">
            <legend>执行策略</legend>
            <div className="strategy-segments">
              {Object.entries(config.strategies.definitions).map(([name, definition]) => (
                <label key={name} className={strategy === name ? "is-selected" : ""}>
                  <input
                    type="radio"
                    name="strategy"
                    value={name}
                    checked={strategy === name}
                    onChange={() => setStrategy(name)}
                  />
                  <span className="strategy-name">
                    <span className="strategy-radio" />
                    <strong title={name}>{strategyDisplayName(name)}</strong>
                  </span>
                  <span>
                    并行 {definition.maxParallel ?? config.project.maxParallel} · 调用 ≤{definition.maxAgentInvocations ?? 64} · {formatDuration(definition.executionTimeoutSeconds ?? 14_400)}
                  </span>
                  <span>
                    返工 {definition.maxReworkAttempts ?? 0} · 审批 {definition.approvalGates?.includes("plan") ? "计划+交付" : "交付"}
                  </span>
                  <span>
                    {morphologySummary(definition, config.project.maxParallel)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <button type="button" className="disclosure-button" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
            <ChevronDown size={16} className={advanced ? "is-open" : ""} />
            角色与模型（CLI / 模型 / 思考深度）
          </button>
          {advanced && (
            <div className="role-binding-grid">
              {!useCliPicker && (
                <p className="policy-notice">
                  <ShieldAlert size={14} />
                  未检测到可用全局 CLI 清单，将使用项目 profile 默认配置。可在「设置」中检索本机 CLI。
                </p>
              )}
              {ROLE_ORDER.map((role) => {
                if (!config.roles[role]) return null;
                const binding = bindings[role] ?? { cli: "grok" as CliId, reasoning: "high" };
                const cli = clisById.get(binding.cli);
                const models = cli?.models ?? [];
                const reasoningOptions = models.find((m) => m.id === binding.model)?.reasoningOptions
                  ?? cli?.models[0]?.reasoningOptions
                  ?? ["low", "medium", "high"];
                return (
                  <div key={role} className="role-binding-card">
                    <strong>{agentRoleLabel(role)}</strong>
                    <label>
                      <span>CLI</span>
                      <select
                        value={binding.cli}
                        disabled={!useCliPicker}
                        onChange={(event) => updateBinding(role, { cli: event.target.value as CliId })}
                      >
                        {(["codex", "grok", "claude", "kimi"] as CliId[]).map((id) => {
                          const item = clisById.get(id);
                          const disabled = !item?.installed || !item.runtimeSupported;
                          return (
                            <option key={id} value={id} disabled={disabled}>
                              {CLI_LABEL[id]}
                              {!item?.installed ? " · 未装" : !item.runtimeSupported ? " · 不可调用" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    <label>
                      <span>模型</span>
                      <select
                        value={binding.model ?? ""}
                        disabled={!useCliPicker}
                        onChange={(event) => updateBinding(role, { model: event.target.value })}
                      >
                        {(models.length > 0 ? models : [{ id: binding.model ?? "default", label: binding.model ?? "默认" }]).map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>思考</span>
                      <select
                        value={binding.reasoning ?? "high"}
                        disabled={!useCliPicker}
                        onChange={(event) => updateBinding(role, { reasoning: event.target.value })}
                      >
                        {reasoningOptions.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    </label>
                    {!useCliPicker && (
                      <small className="role-binding-fallback">
                        策略默认（{profileDisplayName(strategyDefinition?.roleProfiles[role] || config.roles[role]!.defaultProfile)}）
                      </small>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer>
            <button type="button" className="button secondary" onClick={onClose}>取消</button>
            <button type="submit" className="button primary" disabled={busy || !goal.trim()}>
              <Play size={16} fill="currentColor" />
              {busy ? "正在启动" : "启动运行"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function formatDuration(seconds: number): string {
  return seconds % 3_600 === 0 ? `单段 ${seconds / 3_600}h` : `单段 ${Math.round(seconds / 60)}m`;
}
