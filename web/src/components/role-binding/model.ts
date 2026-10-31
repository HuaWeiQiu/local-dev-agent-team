import type { CliId, CliInventory, RoleBindingInput } from "../../types";

export const CLI_ORDER: CliId[] = ["codex", "grok", "claude", "kimi"];

export const FALLBACK_BINDING: RoleBindingInput = { cli: "grok", reasoning: "high" };

const DEFAULT_REASONING = ["low", "medium", "high"];

export function bindingFor(
  roles: Record<string, RoleBindingInput>,
  role: string,
): RoleBindingInput {
  return roles[role] ?? FALLBACK_BINDING;
}

export function cliIndex(inventory: CliInventory | undefined): Map<string, CliInventory["clis"][number]> {
  return new Map((inventory?.clis ?? []).map((cli) => [cli.id, cli]));
}

/** The chosen model's options, then the CLI's first model, then the default set. */
export function reasoningOptions(
  cli: CliInventory["clis"][number] | undefined,
  model: string | undefined,
): string[] {
  const models = cli?.models ?? [];
  return (
    models.find((entry) => entry.id === model)?.reasoningOptions
    ?? models[0]?.reasoningOptions
    ?? DEFAULT_REASONING
  );
}

/** Models offered for a binding, with its current value as the only fallback. */
export function modelChoices(
  cli: CliInventory["clis"][number] | undefined,
  model: string | undefined,
): Array<{ id: string; label: string }> {
  const models = cli?.models ?? [];
  if (models.length > 0) return models;
  return [{ id: model ?? "default", label: model ?? "default" }];
}

export function cliOptionNote(cli: CliInventory["clis"][number] | undefined): string {
  if (!cli?.installed) return "（未安装）";
  return cli.runtimeSupported ? "" : "（暂不可调用）";
}

export function cliOptionDisabled(cli: CliInventory["clis"][number] | undefined): boolean {
  return !cli?.installed || !cli.runtimeSupported;
}

export function sourceLabel(source: "global" | "project"): string {
  return source === "project" ? "项目" : "全局";
}

/** Switching the CLI re-seats the model and reasoning on the new CLI's defaults. */
export function applyRolePatch(
  current: Record<string, RoleBindingInput>,
  role: string,
  patch: Partial<RoleBindingInput>,
  inventory?: CliInventory,
): Record<string, RoleBindingInput> {
  const next = { ...bindingFor(current, role), ...patch };
  const cli = cliIndex(inventory).get(next.cli);
  if (patch.cli && cli) reseat(next, cli);
  return { ...current, [role]: next };
}

function reseat(next: RoleBindingInput, cli: CliInventory["clis"][number]): void {
  const model = cli.defaultModel ?? cli.models[0]?.id;
  if (model) next.model = model;
  next.reasoning = cli.defaultReasoning ?? cli.models[0]?.reasoningOptions?.[0] ?? "high";
}
