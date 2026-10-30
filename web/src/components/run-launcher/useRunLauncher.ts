import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { retrieveExperience } from "../../api";
import { namedDeliverablesInGoal } from "../../plan-completeness";
import { orderedRoles, summarizeGoal } from "../../presentation";
import type {
  CliInventory,
  ExperiencePlanningBundle,
  FlowTemplateChoice,
  PublicConfig,
  ProjectScope,
  RoleBindingInput,
  StartRunInput,
} from "../../types";
import {
  applyBindingPatch,
  cliIndex,
  fallbackBindingFor,
  initialBindings,
  initialStrategy,
  shouldUseCliPicker,
  startRunInput,
} from "./model";

export interface RunLauncherModel {
  goal: string;
  strategy: string;
  template: FlowTemplateChoice;
  advanced: boolean;
  roles: string[];
  bindings: Record<string, RoleBindingInput>;
  fallback: RoleBindingInput;
  inventory: CliInventory | undefined;
  useCliPicker: boolean;
  deliverables: string[];
  experienceItems: string[];
  strategyDefinition: PublicConfig["strategies"]["definitions"][string] | undefined;
  canSubmit: boolean;
  setGoal(value: string): void;
  setStrategy(value: string): void;
  setTemplate(value: FlowTemplateChoice): void;
  toggleAdvanced(): void;
  updateBinding(role: string, patch: Partial<RoleBindingInput>): void;
  submit(event: FormEvent): Promise<void>;
}

/**
 * Form state for the run launcher.
 *
 * The dialog initialises once per open: late `roleDefaults` / inventory
 * refreshes must never overwrite what the operator already picked. That rule
 * lives here as one `initializedRef`, not spread across render branches.
 */
export function useRunLauncher(input: {
  open: boolean;
  config: PublicConfig;
  scope: ProjectScope | undefined;
  initialStrategy: string | undefined;
  initialGoal: string | undefined;
  busy: boolean;
  roleDefaults: Record<string, RoleBindingInput> | undefined;
  inventory: CliInventory | undefined;
  showCliPicker: boolean;
  onSubmit(run: StartRunInput): Promise<boolean>;
}): RunLauncherModel {
  const [goal, setGoal] = useState("");
  const [strategy, setStrategy] = useState(input.config.strategies.default);
  const [template, setTemplate] = useState<FlowTemplateChoice>("auto");
  const [advanced, setAdvanced] = useState(true);
  const [bindings, setBindings] = useState<Record<string, RoleBindingInput>>({});
  const [useCliPicker, setUseCliPicker] = useState(true);
  const [experiencePreview, setExperiencePreview] = useState<ExperiencePlanningBundle>();

  const roles = useMemo(() => orderedRoles(Object.keys(input.config.roles)), [input.config.roles]);
  const fallback = useMemo(() => fallbackBindingFor(input.inventory), [input.inventory]);
  const clisById = useMemo(() => cliIndex(input.inventory), [input.inventory]);

  useExperiencePreview(goal, input.scope, setExperiencePreview);
  useOpenInitialization({
    open: input.open,
    config: input.config,
    roles,
    fallback,
    roleDefaults: input.roleDefaults,
    initialGoal: input.initialGoal,
    initialStrategy: input.initialStrategy,
    inventory: input.inventory,
    showCliPicker: input.showCliPicker,
    onGoal: setGoal,
    onStrategy: setStrategy,
    onTemplate: setTemplate,
    onBindings: setBindings,
    onUseCliPicker: setUseCliPicker,
  });

  const strategyDefinition = input.config.strategies.definitions[strategy];
  const updateBinding = (role: string, patch: Partial<RoleBindingInput>): void => {
    setBindings((current) => applyBindingPatch(current, role, patch, fallback, clisById));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!goal.trim()) return;
    const succeeded = await input.onSubmit(
      startRunInput({
        goal,
        strategy,
        template,
        useCliPicker,
        bindings,
        roles: input.config.roles,
      }),
    );
    // Keep the text on failure so the operator can fix the goal and retry.
    if (succeeded) setGoal("");
  };

  return {
    goal,
    strategy,
    template,
    advanced,
    roles,
    bindings,
    fallback,
    inventory: input.inventory,
    useCliPicker,
    deliverables: namedDeliverablesInGoal(goal),
    experienceItems: previewItems(experiencePreview),
    strategyDefinition,
    canSubmit: !input.busy && goal.trim().length > 0,
    setGoal,
    setStrategy,
    setTemplate,
    toggleAdvanced: () => setAdvanced((value) => !value),
    updateBinding,
    submit,
  };
}

function previewItems(bundle: ExperiencePlanningBundle | undefined): string[] {
  const items = bundle?.items ?? [];
  return items.slice(0, 3).map((item) => summarizeGoal(item.summary, 24));
}

/** Debounced read-only preview of the experience the run would inject. */
function useExperiencePreview(
  goal: string,
  scope: ProjectScope | undefined,
  setPreview: (value: ExperiencePlanningBundle | undefined) => void,
): void {
  useEffect(() => {
    if (!scope) return;
    const text = goal.trim();
    if (!text) {
      setPreview(undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      retrieveExperience(scope, text, { preview: true })
        .then((bundle) => setPreview(bundle))
        .catch(() => setPreview(undefined));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [goal, scope, setPreview]);
}

interface InitInput {
  open: boolean;
  config: PublicConfig;
  roles: string[];
  fallback: RoleBindingInput;
  roleDefaults: Record<string, RoleBindingInput> | undefined;
  initialGoal: string | undefined;
  initialStrategy: string | undefined;
  inventory: CliInventory | undefined;
  showCliPicker: boolean;
  onGoal(value: string): void;
  onStrategy(value: string): void;
  onTemplate(value: FlowTemplateChoice): void;
  onBindings(value: Record<string, RoleBindingInput>): void;
  onUseCliPicker(value: boolean): void;
}

/** Initialise the form exactly once per open, never on prop refreshes. */
function useOpenInitialization(input: InitInput): void {
  const initialized = useRef(false);
  useEffect(() => {
    if (!input.open) {
      initialized.current = false;
      return;
    }
    if (initialized.current) return;
    initialized.current = true;
    applyInitial(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.open]);
}

function applyInitial(input: InitInput): void {
  if (input.initialGoal) input.onGoal(input.initialGoal);
  input.onTemplate("auto");
  input.onStrategy(initialStrategy(input.config, input.initialStrategy));
  input.onBindings(initialBindings(input.roles, input.roleDefaults, input.fallback));
  input.onUseCliPicker(shouldUseCliPicker(input.showCliPicker, input.inventory));
}
