import { agentRoleLabel } from "../presentation";
import type { CliId, CliInventory, RoleBindingInput } from "../types";

const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export function RoleBindingEditor({
  roles,
  roleNames,
  inventory,
  disabled,
  sources,
  onChange,
  onClear,
}: {
  roles: Record<string, RoleBindingInput>;
  roleNames: string[];
  inventory?: CliInventory;
  disabled?: boolean;
  sources?: Record<string, "global" | "project">;
  onChange(role: string, patch: Partial<RoleBindingInput>): void;
  onClear?(role: string): void;
}) {
  const clisById = new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));

  return (
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
        const source = sources?.[role] ?? "global";
        return (
          <div key={role} className={`role-default-card ${source === "project" ? "is-project" : "is-global"}`}>
            <strong>
              {agentRoleLabel(role)}
              {sources && (
                <span className={`role-source-badge is-${source}`}>
                  {source === "project" ? "项目" : "全局"}
                </span>
              )}
            </strong>
            <label>
              <span>Agent CLI</span>
              <select
                value={binding.cli}
                disabled={disabled}
                onChange={(event) => onChange(role, { cli: event.target.value as CliId })}
              >
                {(["codex", "grok", "claude", "kimi"] as CliId[]).map((id) => {
                  const item = clisById.get(id);
                  const optionDisabled = !item?.installed || !item.runtimeSupported;
                  return (
                    <option key={id} value={id} disabled={optionDisabled}>
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
                disabled={disabled}
                onChange={(event) => onChange(role, { model: event.target.value })}
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
                disabled={disabled}
                onChange={(event) => onChange(role, { reasoning: event.target.value })}
              >
                {reasoningOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            {onClear && source === "project" && (
              <button
                type="button"
                className="button secondary role-inherit-button"
                disabled={disabled}
                onClick={() => onClear(role)}
              >
                恢复全局
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function applyRolePatch(
  current: Record<string, RoleBindingInput>,
  role: string,
  patch: Partial<RoleBindingInput>,
  inventory?: CliInventory,
): Record<string, RoleBindingInput> {
  const clisById = new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));
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
}
