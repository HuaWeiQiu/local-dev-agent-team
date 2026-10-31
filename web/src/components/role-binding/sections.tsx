import type { ReactNode } from "react";
import { agentRoleLabel } from "../../presentation";
import type { CliId, CliInventory, RoleBindingInput } from "../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Select } from "../../ui/form";
import {
  CLI_ORDER,
  bindingFor,
  cliIndex,
  cliOptionDisabled,
  cliOptionNote,
  modelChoices,
  reasoningOptions,
  sourceLabel,
} from "./model";

const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export const COLUMNS = "md:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)]";

export function RoleRow({
  role,
  roles,
  inventory,
  disabled,
  source,
  showSources,
  onChange,
  onClear,
}: {
  role: string;
  roles: Record<string, RoleBindingInput>;
  inventory: CliInventory | undefined;
  disabled: boolean;
  source: "global" | "project";
  showSources: boolean;
  onChange(role: string, patch: Partial<RoleBindingInput>): void;
  onClear: ((role: string) => void) | undefined;
}) {
  const clis = cliIndex(inventory);
  const binding = bindingFor(roles, role);
  const cli = clis.get(binding.cli);
  return (
    <div
      className={cn(
        "grid gap-3 px-3 py-3 md:items-center md:gap-3",
        COLUMNS,
        source === "project" && "bg-accent-soft/40",
      )}
    >
      <RoleIdentity
        role={role}
        source={source}
        showSources={showSources}
        disabled={disabled}
        onClear={onClear}
      />
      <Labeled label="Agent CLI">
        <Select
          value={binding.cli}
          disabled={disabled}
          onChange={(event) => onChange(role, { cli: event.target.value as CliId })}
        >
          {CLI_ORDER.map((id) => (
            <CliOption key={id} id={id} cli={clis.get(id)} />
          ))}
        </Select>
      </Labeled>
      <Labeled label="模型">
        <Select
          value={binding.model ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(role, { model: event.target.value })}
        >
          {modelChoices(cli, binding.model).map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </Select>
      </Labeled>
      <Labeled label="思考深度">
        <Select
          value={binding.reasoning ?? "high"}
          disabled={disabled}
          onChange={(event) => onChange(role, { reasoning: event.target.value })}
        >
          {reasoningOptions(cli, binding.model).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Labeled>
    </div>
  );
}

function RoleIdentity({
  role,
  source,
  showSources,
  disabled,
  onClear,
}: {
  role: string;
  source: "global" | "project";
  showSources: boolean;
  disabled: boolean;
  onClear: ((role: string) => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-sm font-semibold text-ink">{agentRoleLabel(role)}</strong>
      {showSources && (
        <Badge tone={source === "project" ? "active" : "neutral"}>{sourceLabel(source)}</Badge>
      )}
      {onClear && source === "project" && (
        <Button size="sm" disabled={disabled} onClick={() => onClear(role)}>
          恢复全局
        </Button>
      )}
    </div>
  );
}

function CliOption({
  id,
  cli,
}: {
  id: CliId;
  cli: CliInventory["clis"][number] | undefined;
}) {
  return (
    <option value={id} disabled={cliOptionDisabled(cli)}>
      {CLI_LABEL[id]}
      {cliOptionNote(cli)}
    </option>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      <span className="md:sr-only">{label}</span>
      {children}
    </label>
  );
}
