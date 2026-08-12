import { ChevronDown, Play, ShieldAlert, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { PublicConfig, StartRunInput } from "../types";

interface RunLauncherProps {
  open: boolean;
  config: PublicConfig;
  initialStrategy?: string;
  busy: boolean;
  error: string | undefined;
  onClose(): void;
  onSubmit(input: StartRunInput): Promise<void>;
}

export function RunLauncher({ open, config, initialStrategy, busy, error, onClose, onSubmit }: RunLauncherProps) {
  const [goal, setGoal] = useState("");
  const [strategy, setStrategy] = useState(config.strategies.default);
  const [advanced, setAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setStrategy(
        initialStrategy && config.strategies.definitions[initialStrategy]
          ? initialStrategy
          : config.strategies.default,
      );
    }
  }, [config.strategies.default, config.strategies.definitions, initialStrategy, open]);

  if (!open) {
    return null;
  }

  const strategyDefinition = config.strategies.definitions[strategy];
  const strategyProfile = (role: string, defaultProfile: string) =>
    strategyDefinition?.roleProfiles[role] || defaultProfile;
  const inheritedMcpRoles = Object.entries(config.roles)
    .filter(([role, policy]) => {
      const profileName = overrides[role] || strategyProfile(role, policy.defaultProfile);
      return config.profiles[profileName]?.externalTools === "inherit";
    })
    .map(([role]) => role);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      return;
    }
    await onSubmit({
      goal: trimmedGoal,
      ...(strategy !== "legacy" ? { strategy } : {}),
      profileOverrides: Object.fromEntries(
        Object.entries(overrides).filter(([, profile]) => profile.length > 0),
      ),
    });
    setGoal("");
    setOverrides({});
    setAdvanced(false);
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
                    <strong>{name}</strong>
                  </span>
                  <span>
                    并行 {definition.maxParallel ?? config.project.maxParallel} · 调用 ≤{definition.maxAgentInvocations ?? 64} · {formatDuration(definition.executionTimeoutSeconds ?? 14_400)}
                  </span>
                  <span>
                    返工 {definition.maxReworkAttempts ?? 0} · 审批 {definition.approvalGates?.includes("plan") ? "计划+交付" : "交付"}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {inheritedMcpRoles.length > 0 && (
            <p className="policy-notice">
              <ShieldAlert size={14} />
              MCP 继承：{inheritedMcpRoles.join("、")}
            </p>
          )}

          <button type="button" className="disclosure-button" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}>
            <ChevronDown size={16} className={advanced ? "is-open" : ""} />
            角色 Profile 覆盖
          </button>
          {advanced && (
            <div className="profile-grid">
              {Object.entries(config.roles).map(([role, policy]) => (
                <label key={role}>
                  <span>{role}</span>
                  <select
                    value={overrides[role] ?? ""}
                    onChange={(event) => setOverrides((current) => ({ ...current, [role]: event.target.value }))}
                  >
                    <option value="">
                      策略默认 ({strategyProfile(role, policy.defaultProfile)})
                    </option>
                    {policy.allowedProfiles.map((profile) => (
                      <option key={profile} value={profile}>
                        {profile}{config.profiles[profile]?.externalTools === "inherit" ? " · MCP" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
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
