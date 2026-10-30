import type {
  CliId,
  CliInventory,
  CliProbeResult,
  FlowTemplateChoice,
  PublicConfig,
  RoleBindingInput,
  StartRunInput,
} from "../../types";

export const TEMPLATE_OPTIONS: Array<{
  id: FlowTemplateChoice;
  label: string;
  hint: string;
}> = [
  { id: "auto", label: "自动选择", hint: "根据目标规模自动选择流程，并在运行中展示理由。" },
  { id: "quick", label: "快速", hint: "直接实现并校验，重复失败时尽早停下，适合小改动。" },
  { id: "standard", label: "标准", hint: "规划 → 实现 → 评审 → 交付，适合多数需求。" },
  { id: "full", label: "完整", hint: "增加调研与更严格的评审，适合大改动或高风险变更。" },
];

export const CLI_LABEL: Record<CliId, string> = {
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  claude: "Claude",
};

export const CLI_ORDER: CliId[] = ["codex", "grok", "claude", "kimi"];

/** First CLI that is actually installed and runtime-capable, else a safe default. */
export function fallbackBindingFor(inventory: CliInventory | undefined): RoleBindingInput {
  const usable = inventory?.clis.find((cli) => cli.installed && cli.runtimeSupported);
  if (!usable) return { cli: "grok", model: "grok", reasoning: "high" };
  return {
    cli: usable.id,
    ...(usable.defaultModel ? { model: usable.defaultModel } : {}),
    reasoning: usable.defaultReasoning ?? "high",
  };
}

export function cliIndex(inventory: CliInventory | undefined): Map<CliId, CliProbeResult> {
  return new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));
}

/** The CLI picker is usable only when a runtime-capable CLI was detected. */
export function shouldUseCliPicker(
  showCliPicker: boolean,
  inventory: CliInventory | undefined,
): boolean {
  const usable = (inventory?.clis ?? []).some((cli) => cli.installed && cli.runtimeSupported);
  return showCliPicker && usable;
}

/** Bindings written when the dialog opens: per-role defaults, else the fallback. */
export function initialBindings(
  roles: string[],
  roleDefaults: Record<string, RoleBindingInput> | undefined,
  fallback: RoleBindingInput,
): Record<string, RoleBindingInput> {
  const next: Record<string, RoleBindingInput> = {};
  for (const role of roles) next[role] = roleDefaults?.[role] ?? fallback;
  return next;
}

export function initialStrategy(
  config: PublicConfig,
  requested: string | undefined,
): string {
  if (requested && config.strategies.definitions[requested]) return requested;
  return config.strategies.default;
}

/**
 * Apply a role binding patch. Changing the CLI re-seats the model and reasoning
 * level on that CLI's advertised defaults.
 */
export function applyBindingPatch(
  current: Record<string, RoleBindingInput>,
  role: string,
  patch: Partial<RoleBindingInput>,
  fallback: RoleBindingInput,
  clisById: Map<CliId, CliProbeResult>,
): Record<string, RoleBindingInput> {
  const next = { ...(current[role] ?? fallback), ...patch };
  if (patch.cli) reseatBinding(next, clisById.get(patch.cli));
  return { ...current, [role]: next };
}

function reseatBinding(binding: RoleBindingInput, cli: CliProbeResult | undefined): void {
  const model = pickModel(cli);
  if (model) binding.model = model;
  binding.reasoning = pickReasoning(cli) ?? binding.reasoning ?? "high";
}

function pickModel(cli: CliProbeResult | undefined): string | undefined {
  return cli?.defaultModel ?? cli?.models[0]?.id;
}

function pickReasoning(cli: CliProbeResult | undefined): string | undefined {
  return cli?.defaultReasoning ?? cli?.models[0]?.reasoningOptions?.[0];
}

export function reasoningOptionsFor(
  cli: CliProbeResult | undefined,
  binding: RoleBindingInput,
): string[] {
  const models = cli?.models ?? [];
  const fromModel = models.find((model) => model.id === binding.model)?.reasoningOptions;
  return fromModel ?? cli?.models[0]?.reasoningOptions ?? ["low", "medium", "high"];
}

export function modelOptions(
  cli: CliProbeResult | undefined,
  binding: RoleBindingInput,
): Array<{ id: string; label: string }> {
  const models = cli?.models ?? [];
  if (models.length > 0) return models;
  const id = binding.model ?? "default";
  return [{ id, label: binding.model ?? "默认" }];
}

export function cliOptionLabel(id: CliId, cli: CliProbeResult | undefined): string {
  if (!cli?.installed) return `${CLI_LABEL[id]} · 未装`;
  if (!cli.runtimeSupported) return `${CLI_LABEL[id]} · 不可调用`;
  return CLI_LABEL[id];
}

export function cliDisabled(cli: CliProbeResult | undefined): boolean {
  return !cli?.installed || !cli.runtimeSupported;
}

/** Start payload: only runtime roles are forwarded, and only when the picker is on. */
export function startRunInput(input: {
  goal: string;
  strategy: string;
  template: FlowTemplateChoice;
  useCliPicker: boolean;
  bindings: Record<string, RoleBindingInput>;
  roles: Record<string, unknown>;
}): StartRunInput {
  const bindings = input.useCliPicker
    ? Object.fromEntries(Object.entries(input.bindings).filter(([role]) => input.roles[role]))
    : {};
  const hasBindings = Object.keys(bindings).length > 0;
  return {
    goal: input.goal.trim(),
    strategy: input.strategy,
    ...(input.template !== "auto" ? { template: input.template } : {}),
    profileOverrides: {},
    ...(hasBindings ? { roleBindings: bindings } : {}),
  };
}

export function templateHint(template: FlowTemplateChoice): string | undefined {
  return TEMPLATE_OPTIONS.find((option) => option.id === template)?.hint;
}

export function formatDuration(seconds: number): string {
  return seconds % 3_600 === 0
    ? `单段 ${seconds / 3_600}h`
    : `单段 ${Math.round(seconds / 60)}m`;
}

export function approvalSummary(definition: { approvalGates?: readonly string[] }): string {
  return definition.approvalGates?.includes("plan") ? "计划+交付" : "交付";
}
