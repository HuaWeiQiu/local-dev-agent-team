import { ChevronDown, Play, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { retrieveExperience } from "../api";
import { namedDeliverablesInGoal } from "../plan-completeness";
import {
  agentRoleLabel,
  morphologySummary,
  orderedRoles,
  profileDisplayName,
  strategyDisplayName,
  summarizeGoal,
} from "../presentation";
import type {
  CliId,
  CliInventory,
  ExperiencePlanningBundle,
  ProjectScope,
  PublicConfig,
  RoleBindingInput,
  StartRunInput,
} from "../types";

interface RunLauncherProps {
  open: boolean;
  config: PublicConfig;
  /** 有 scope 时目标输入区展示经验注入预览 */
  scope?: ProjectScope;
  initialStrategy?: string;
  busy: boolean;
  error: string | undefined;
  /** Global defaults + inventory for CLI picker */
  roleDefaults?: Record<string, RoleBindingInput>;
  inventory?: CliInventory;
  /** 「设置」中的新建运行选型开关；关闭时角色区只读展示当前绑定 */
  showCliPicker?: boolean;
  onClose(): void;
  /** 返回是否启动成功；失败时保留目标文本与弹窗 */
  onSubmit(input: StartRunInput): Promise<boolean>;
}

const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export function RunLauncher({
  open,
  config,
  scope,
  initialStrategy,
  busy,
  error,
  roleDefaults,
  inventory,
  showCliPicker = true,
  onClose,
  onSubmit,
}: RunLauncherProps) {
  const [goal, setGoal] = useState("");
  const [strategy, setStrategy] = useState(config.strategies.default);
  const [advanced, setAdvanced] = useState(true);
  const [bindings, setBindings] = useState<Record<string, RoleBindingInput>>({});
  const [useCliPicker, setUseCliPicker] = useState(true);
  const [experiencePreview, setExperiencePreview] = useState<ExperiencePlanningBundle>();

  const roles = useMemo(() => orderedRoles(Object.keys(config.roles)), [config.roles]);

  // 目标输入防抖预览：启动时将注入规划的已验证经验（只读 preview，不计命中）
  useEffect(() => {
    if (!scope) return;
    const text = goal.trim();
    if (!text) {
      setExperiencePreview(undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      retrieveExperience(scope, text, { preview: true })
        .then((bundle) => setExperiencePreview(bundle))
        .catch(() => setExperiencePreview(undefined));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [goal, scope]);

  const clisById = useMemo(() => {
    const map = new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));
    return map;
  }, [inventory]);

  // 兜底绑定：优先第一个已安装且可调用的 CLI，避免选中「未安装」的禁用项
  const fallbackBinding = useMemo<RoleBindingInput>(() => {
    const usable = inventory?.clis.find((cli) => cli.installed && cli.runtimeSupported);
    if (usable) {
      return {
        cli: usable.id,
        ...(usable.defaultModel ? { model: usable.defaultModel } : {}),
        reasoning: usable.defaultReasoning ?? "high",
      };
    }
    return { cli: "grok" as CliId, model: "grok", reasoning: "high" };
  }, [inventory]);

  // 只在弹窗 open 由 false→true 时初始化一次；
  // 之后 roleDefaults / inventory 的晚到刷新（如焦点回归检测）不得覆盖用户编辑
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    setStrategy(
      initialStrategy && config.strategies.definitions[initialStrategy]
        ? initialStrategy
        : config.strategies.default,
    );
    const next: Record<string, RoleBindingInput> = {};
    for (const role of roles) {
      next[role] = roleDefaults?.[role] ?? fallbackBinding;
    }
    setBindings(next);
    setUseCliPicker(
      showCliPicker && Boolean(inventory && inventory.clis.some((c) => c.installed && c.runtimeSupported)),
    );
    // 仅在打开瞬间读取最新 props；deps 变化由 initializedRef 拦截
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) {
    return null;
  }

  const strategyDefinition = config.strategies.definitions[strategy];

  const updateBinding = (role: string, patch: Partial<RoleBindingInput>) => {
    setBindings((current) => {
      const base = current[role] ?? fallbackBinding;
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

    const succeeded = await onSubmit({
      goal: trimmedGoal,
      strategy,
      profileOverrides: {},
      ...(roleBindings && Object.keys(roleBindings).length > 0 ? { roleBindings } : {}),
    });
    // 仅启动成功才清空目标文本；失败时保留输入与弹窗
    if (succeeded) setGoal("");
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
          <p className="run-goal-hint">
            大改动请列出 T1–Tn、路径和验收。只写「根据文档执行」通常只会得到一条读文档任务。
          </p>
          {namedDeliverablesInGoal(goal).length > 0 && (
            <p className="run-goal-hint is-preview">
              将校验计划是否覆盖 {namedDeliverablesInGoal(goal).join("、")}。
            </p>
          )}
          {experiencePreview && experiencePreview.items.length > 0 && (
            <p className="run-goal-experience-preview">
              将注入 {experiencePreview.items.length} 条已验证经验：
              {experiencePreview.items
                .slice(0, 3)
                .map((item) => summarizeGoal(item.summary, 24))
                .join("；")}
              {experiencePreview.items.length > 3 ? " …" : ""}
            </p>
          )}

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
                  {!showCliPicker
                    ? "已在「设置」中关闭新建运行选型，将使用项目 profile 默认配置；以下为当前默认绑定（只读）。"
                    : "未检测到可用全局 CLI 清单，将使用项目 profile 默认配置。可在「设置」中检索本机 CLI。"}
                </p>
              )}
              {roles.map((role) => {
                if (!config.roles[role]) return null;
                const binding = bindings[role] ?? fallbackBinding;
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
