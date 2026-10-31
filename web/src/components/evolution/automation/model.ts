import type { AutomaticEvolutionCycle, AutomaticEvolutionSnapshot } from "../../../types";

export function isAutomationActive(automation: AutomaticEvolutionSnapshot): boolean {
  return automation.status === "running" || automation.status === "stopping";
}

export function latestCycle(
  automation: AutomaticEvolutionSnapshot,
): AutomaticEvolutionCycle | undefined {
  return automation.cycles.at(-1);
}

/** A stop reason only matters once the loop is no longer running. */
export function automationNote(automation: AutomaticEvolutionSnapshot): string | undefined {
  const explicit = automation.error ?? undefined;
  if (explicit) return explicit;
  return isAutomationActive(automation) ? undefined : automation.stopReason ?? undefined;
}

export function noteIsError(automation: AutomaticEvolutionSnapshot): boolean {
  return Boolean(automation.error) || automation.status === "paused";
}

export function roleBindingLabel(source: AutomaticEvolutionSnapshot["roleBindingSource"]): string {
  if (source === "layered-cli-defaults" || source === "global-cli-defaults") return "全局/项目默认";
  return "项目 yaml";
}

export function cycleDecisionLabel(cycle: AutomaticEvolutionCycle): string {
  return cycle.decision === "promoted" ? "已采纳" : "未采纳";
}

export function showFooter(automation: AutomaticEvolutionSnapshot): boolean {
  return automation.cycles.length > 0 || Boolean(automationNote(automation));
}

/** Start is blocked while disabled, busy, locked or already retrying. */
export function startDisabled(input: {
  automation: AutomaticEvolutionSnapshot;
  busy: boolean;
  mutationLocked: boolean;
}): boolean {
  return !input.automation.enabled || input.busy || input.mutationLocked;
}

export function cyclesInputDisabled(input: {
  automation: AutomaticEvolutionSnapshot;
  busy: boolean;
  mutationLocked: boolean;
  startIntentPending: boolean;
}): boolean {
  return (
    startDisabled(input) || input.startIntentPending || input.automation.configuredMaxCycles <= 0
  );
}
