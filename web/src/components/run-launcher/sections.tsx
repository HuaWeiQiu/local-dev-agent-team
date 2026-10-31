import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import type {
  CliId,
  CliInventory,
  CliProbeResult,
  FlowTemplateChoice,
  PublicConfig,
  RoleBindingInput,
} from "../../types";
import {
  agentRoleLabel,
  morphologySummary,
  profileDisplayName,
  strategyDisplayName,
} from "../../presentation";
import { cn } from "../../ui/cn";
import { Callout, Field, Select, Textarea } from "../../ui/form";
import {
  approvalSummary,
  CLI_ORDER,
  cliDisabled,
  cliOptionLabel,
  formatDuration,
  modelOptions,
  reasoningOptionsFor,
  TEMPLATE_OPTIONS,
  templateHint,
} from "./model";

export function GoalField({
  goal,
  onGoalChange,
  deliverables,
  experienceItems,
}: {
  goal: string;
  onGoalChange(value: string): void;
  deliverables: string[];
  experienceItems: string[];
}) {
  return (
    <>
      <Field
        label="目标"
        htmlFor="run-goal"
        hint="大改动请列出 T1–Tn、路径和验收。只写「根据文档执行」通常只会得到一条读文档任务。"
      >
        <Textarea
          id="run-goal"
          data-autofocus
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          placeholder="例如：为订单模块增加幂等退款接口，并补齐测试"
          rows={4}
          required
        />
      </Field>
      {deliverables.length > 0 && (
        <Callout tone="info" className="-mt-2">
          将校验计划是否覆盖 {deliverables.join("、")}。
        </Callout>
      )}
      {experienceItems.length > 0 && (
        <Callout tone="success" className="-mt-2">
          将注入 {experienceItems.length} 条已验证经验：{experienceItems.join("；")}
          {experienceItems.length > 3 ? " …" : ""}
        </Callout>
      )}
    </>
  );
}

export function StrategyPicker({
  config,
  strategy,
  onSelect,
}: {
  config: PublicConfig;
  strategy: string;
  onSelect(name: string): void;
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-2 p-0 text-xs font-medium text-ink-2">执行策略</legend>
      <div className="strategy-segments grid gap-2 sm:grid-cols-2">
        {Object.entries(config.strategies.definitions).map(([name, definition]) => (
          <StrategyOption
            key={name}
            name={name}
            selected={strategy === name}
            summary={[
              `并行 ${definition.maxParallel ?? config.project.maxParallel} · 调用 ≤${definition.maxAgentInvocations ?? 64} · ${formatDuration(definition.executionTimeoutSeconds ?? 14_400)}`,
              `返工 ${definition.maxReworkAttempts ?? 0} · 审批 ${approvalSummary(definition)}`,
              morphologySummary(definition, config.project.maxParallel),
            ]}
            onSelect={onSelect}
          />
        ))}
      </div>
    </fieldset>
  );
}

function StrategyOption({
  name,
  selected,
  summary,
  onSelect,
}: {
  name: string;
  selected: boolean;
  summary: string[];
  onSelect(name: string): void;
}) {
  return (
    <label
      className={cn(
        "bd relative flex cursor-pointer flex-col gap-1 rounded-lg bg-surface p-3 text-xs text-muted transition-colors outline-accent outline-offset-2 hover:border-line-strong hover:bg-surface-2 has-[:focus-visible]:outline-2",
        selected && "is-selected border-accent bg-accent-soft/60 text-ink-2 hover:bg-accent-soft/60",
      )}
    >
      <input
        className="sr-only"
        type="radio"
        name="strategy"
        value={name}
        checked={selected}
        onChange={() => onSelect(name)}
      />
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "grid size-3.5 place-items-center rounded-full border border-line-strong bg-surface",
            selected && "border-accent bg-accent",
          )}
        >
          {selected && <span className="size-1.5 rounded-full bg-on-accent" />}
        </span>
        <strong className="text-sm font-semibold text-ink" title={name}>
          {strategyDisplayName(name)}
        </strong>
      </span>
      {summary.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </label>
  );
}

export function TemplateField({
  template,
  onChange,
}: {
  template: FlowTemplateChoice;
  onChange(value: FlowTemplateChoice): void;
}) {
  const hint = templateHint(template);
  return (
    <Field label="流程模板" htmlFor="run-template" {...(hint ? { hint } : {})}>
      <Select
        id="run-template"
        value={template}
        onChange={(event) => onChange(event.target.value as FlowTemplateChoice)}
      >
        {TEMPLATE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function AdvancedToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="-mx-1 flex w-fit cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-xs font-medium text-ink-2 hover:text-ink focus-ring"
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <ChevronDown className={cn("size-4 transition-transform", !expanded && "-rotate-90")} />
      角色与模型（CLI / 模型 / 思考深度）
    </button>
  );
}

export function RoleBindingGrid({
  roles,
  config,
  bindings,
  fallback,
  inventory,
  strategyDefinition,
  useCliPicker,
  showCliPicker,
  onChange,
}: {
  roles: string[];
  config: PublicConfig;
  bindings: Record<string, RoleBindingInput>;
  fallback: RoleBindingInput;
  inventory: CliInventory | undefined;
  strategyDefinition: PublicConfig["strategies"]["definitions"][string] | undefined;
  useCliPicker: boolean;
  showCliPicker: boolean;
  onChange(role: string, patch: Partial<RoleBindingInput>): void;
}) {
  const clisById = new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));
  return (
    <div className="role-binding-grid bd flex flex-col divide-y overflow-hidden rounded-lg bg-surface">
      {!useCliPicker && (
        <Callout tone="warning" className="rounded-none border-0">
          {pickerNotice(showCliPicker)}
        </Callout>
      )}
      {roles.map((role) => renderRow({ role, config, bindings, fallback, clisById, useCliPicker, strategyDefinition, onChange }))}
    </div>
  );
}

function renderRow(input: {
  role: string;
  config: PublicConfig;
  bindings: Record<string, RoleBindingInput>;
  fallback: RoleBindingInput;
  clisById: Map<CliId, CliProbeResult>;
  useCliPicker: boolean;
  strategyDefinition: PublicConfig["strategies"]["definitions"][string] | undefined;
  onChange(role: string, patch: Partial<RoleBindingInput>): void;
}) {
  const roleConfig = input.config.roles[input.role];
  if (!roleConfig) return null;
  const binding = input.bindings[input.role] ?? input.fallback;
  const profile = input.strategyDefinition?.roleProfiles?.[input.role];
  return (
    <RoleBindingRow
      key={input.role}
      role={input.role}
      binding={binding}
      cli={input.clisById.get(binding.cli)}
      clisById={input.clisById}
      useCliPicker={input.useCliPicker}
      strategyProfile={profile ?? roleConfig.defaultProfile}
      onChange={input.onChange}
    />
  );
}

function pickerNotice(showCliPicker: boolean): string {
  return showCliPicker
    ? "未检测到可用全局 CLI 清单，将使用项目 profile 默认配置。可在「设置」中检索本机 CLI。"
    : "已在「设置」中关闭新建运行选型，将使用项目 profile 默认配置；以下为当前默认绑定（只读）。";
}

export function RoleBindingRow({
  role,
  binding,
  cli,
  clisById,
  useCliPicker,
  strategyProfile,
  onChange,
}: {
  role: string;
  binding: RoleBindingInput;
  cli: CliProbeResult | undefined;
  clisById: Map<CliId, CliProbeResult>;
  useCliPicker: boolean;
  strategyProfile: string | undefined;
  onChange(role: string, patch: Partial<RoleBindingInput>): void;
}) {
  return (
    <div className="role-binding-card grid items-center gap-2 px-3 py-2.5 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
      <strong className="text-sm font-semibold text-ink">{agentRoleLabel(role)}</strong>
      <BindingSelect label="CLI">
        <Select
          value={binding.cli}
          disabled={!useCliPicker}
          onChange={(event) => onChange(role, { cli: event.target.value as CliId })}
        >
          {CLI_ORDER.map((id) => (
            <option key={id} value={id} disabled={cliDisabled(clisById.get(id))}>
              {cliOptionLabel(id, clisById.get(id))}
            </option>
          ))}
        </Select>
      </BindingSelect>
      <BindingSelect label="模型">
        <Select
          value={binding.model ?? ""}
          disabled={!useCliPicker}
          onChange={(event) => onChange(role, { model: event.target.value })}
        >
          {modelOptions(cli, binding).map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </Select>
      </BindingSelect>
      <BindingSelect label="思考">
        <Select
          value={binding.reasoning ?? "high"}
          disabled={!useCliPicker}
          onChange={(event) => onChange(role, { reasoning: event.target.value })}
        >
          {reasoningOptionsFor(cli, binding).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </BindingSelect>
      {!useCliPicker && (
        <small className="text-xs text-muted">
          策略默认（{profileDisplayName(strategyProfile)}）
        </small>
      )}
    </div>
  );
}

export function BindingSelect({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-2 text-xs text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}
