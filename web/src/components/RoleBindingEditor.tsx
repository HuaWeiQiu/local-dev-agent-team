import type { ReactNode } from "react";
import { agentRoleLabel } from "../presentation";
import type { CliId, CliInventory, RoleBindingInput } from "../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Select } from "../ui/form";

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
    <div className="role-default-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
          <div
            key={role}
            className={cn(
              "bd flex flex-col gap-2.5 rounded-lg bg-surface-2 p-3.5",
              source === "project" && "border-accent-line bg-accent-soft/40",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm font-semibold text-ink">{agentRoleLabel(role)}</strong>
              {sources && (
                <Badge tone={source === "project" ? "active" : "neutral"}>{source === "project" ? "项目" : "全局"}</Badge>
              )}
            </div>
            <Labeled label="Agent CLI">
              <Select
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
              </Select>
            </Labeled>
            <Labeled label="模型">
              <Select
                value={binding.model ?? ""}
                disabled={disabled}
                onChange={(event) => onChange(role, { model: event.target.value })}
              >
                {(models.length > 0 ? models : [{ id: binding.model ?? "default", label: binding.model ?? "default" }]).map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </Select>
            </Labeled>
            <Labeled label="思考深度">
              <Select
                value={binding.reasoning ?? "high"}
                disabled={disabled}
                onChange={(event) => onChange(role, { reasoning: event.target.value })}
              >
                {reasoningOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </Select>
            </Labeled>
            {onClear && source === "project" && (
              <Button size="sm" disabled={disabled} onClick={() => onClear(role)}>
                恢复全局
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      <span>{label}</span>
      {children}
    </label>
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
