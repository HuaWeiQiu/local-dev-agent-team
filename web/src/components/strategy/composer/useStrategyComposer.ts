import { useEffect, useMemo, useState } from "react";
import { useFlowPalette } from "../../../flow-theme";
import { useMediaQuery } from "../../../useMediaQuery";
import type { PublicConfig, StrategyBlueprintResult } from "../../../types";
import type { StrategyDraft } from "../draft";
import {
  blueprintNameFor,
  buildBlueprintDefinition,
  buildPreviewTopology,
  buildStrategyGraph,
  createDraft,
  sameDraft,
} from "../draft";
import {
  definitionFor,
  DELETE_FEEDBACK,
  errorFeedback,
  feedbackFor,
  type ComposerAction,
  type ComposerFeedback,
} from "./model";

export interface ComposerHost {
  config: PublicConfig;
  onPreflight(name: string, definition: unknown): Promise<StrategyBlueprintResult>;
  onSave(name: string, definition: unknown): Promise<StrategyBlueprintResult>;
  onDelete(name: string): Promise<void>;
  onLaunch(strategy: string): void;
}

export interface StrategyComposerModel {
  strategyNames: string[];
  selectedName: string;
  definition: ReturnType<typeof definitionFor>;
  draft: StrategyDraft;
  blueprintName: string;
  feedback: ComposerFeedback | undefined;
  submitting: boolean;
  dirty: boolean;
  topology: ReturnType<typeof buildPreviewTopology>;
  graph: ReturnType<typeof buildStrategyGraph>;
  palette: ReturnType<typeof useFlowPalette>;
  compactLayout: boolean;
  libraryOpen: boolean;
  inspectorOpen: boolean;
  panelOpen: boolean;
  workspace: {
    setBlueprintName(value: string): void;
    setLibraryOpen(): void;
    setInspectorOpen(): void;
    closePanels(): void;
    selectStrategy(name: string): void;
    updateDraft(update: (current: StrategyDraft) => StrategyDraft): void;
    resetDraft(): void;
    run(action: ComposerAction): Promise<void>;
    launch(): void;
  };
}

/**
 * Composer state machine: which strategy is selected, the draft being edited,
 * whether it differs from what is persisted, and the three actions that may
 * run against it. Split out so the workspace render stays a layout.
 */
export function useStrategyComposer(host: ComposerHost): StrategyComposerModel {
  const { config } = host;
  const strategyNames = Object.keys(config.strategies.definitions);
  const [selectedName, setSelectedName] = useState(config.strategies.default);
  const definition = definitionFor(config, selectedName);
  const [draft, setDraft] = useState<StrategyDraft>(() => createDraft(definition, config));
  const [blueprintName, setBlueprintName] = useState(() => blueprintNameFor(selectedName, definition));
  const [pendingSelection, setPendingSelection] = useState<string>();
  const [feedback, setFeedback] = useState<ComposerFeedback>();
  const [submitting, setSubmitting] = useState(false);
  const [libraryOpen, setLibraryOpenState] = useState(false);
  const compactLayout = useMediaQuery("(max-width: 800px)");
  const [inspectorOpen, setInspectorOpenState] = useState(() => !compactLayout);

  useSelectionGuards({
    config,
    selectedName,
    definition,
    pendingSelection,
    compactLayout,
    onSelect: setSelectedName,
    onDraft: setDraft,
    onBlueprintName: setBlueprintName,
    onPending: setPendingSelection,
    onLibrary: setLibraryOpenState,
    onInspector: setInspectorOpenState,
  });

  const palette = useFlowPalette();
  const topology = useMemo(
    () => buildPreviewTopology(definition.compiledTopology, draft),
    [definition.compiledTopology, draft],
  );
  const graph = useMemo(
    () => buildStrategyGraph(topology, compactLayout, palette.edge),
    [compactLayout, palette.edge, topology],
  );
  const persistedDraft = useMemo(() => createDraft(definition, config), [config, definition]);
  const dirty = !sameDraft(draft, persistedDraft);
  const blueprintDefinition = useMemo(
    () => buildBlueprintDefinition(definition, draft),
    [definition, draft],
  );
  const run = createRunner({
    host,
    selectedName,
    blueprintName,
    blueprintDefinition,
    setSubmitting,
    setFeedback,
    setPendingSelection,
  });

  return {
    strategyNames,
    selectedName,
    definition,
    draft,
    blueprintName,
    feedback,
    submitting,
    dirty,
    topology,
    graph,
    palette,
    compactLayout,
    libraryOpen,
    inspectorOpen,
    panelOpen: libraryOpen || inspectorOpen,
    workspace: {
      setBlueprintName: (value) => {
        setBlueprintName(value);
        setFeedback(undefined);
      },
      setLibraryOpen: () => setLibraryOpenState((open) => !open),
      setInspectorOpen: () => setInspectorOpenState((open) => !open),
      closePanels: () => {
        setLibraryOpenState(false);
        setInspectorOpenState(false);
      },
      selectStrategy: (name) => {
        setFeedback(undefined);
        setSelectedName(name);
      },
      updateDraft: (update) => {
        setFeedback(undefined);
        setDraft(update);
      },
      resetDraft: () => {
        setDraft(createDraft(definition, config));
        setFeedback(undefined);
      },
      run,
      launch: () => host.onLaunch(selectedName),
    },
  };
}

interface GuardInput {
  config: PublicConfig;
  selectedName: string;
  definition: ReturnType<typeof definitionFor>;
  pendingSelection: string | undefined;
  compactLayout: boolean;
  onSelect(name: string): void;
  onDraft(value: StrategyDraft): void;
  onBlueprintName(value: string): void;
  onPending(value: string | undefined): void;
  onLibrary(open: boolean): void;
  onInspector(open: boolean): void;
}

/** Selection fallbacks, draft resets and the compact-layout panel rules. */
function useSelectionGuards(input: GuardInput): void {
  const { config, selectedName, definition, pendingSelection, compactLayout } = input;
  useEffect(() => {
    if (!config.strategies.definitions[selectedName]) input.onSelect(config.strategies.default);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.strategies.default, config.strategies.definitions, selectedName]);

  useEffect(() => {
    input.onDraft(createDraft(definition, config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, definition, selectedName]);

  useEffect(() => {
    input.onBlueprintName(blueprintNameFor(selectedName, definition));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.source, selectedName]);

  useEffect(() => {
    if (!pendingSelection || !config.strategies.definitions[pendingSelection]) return;
    input.onSelect(pendingSelection);
    input.onPending(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.strategies.definitions, pendingSelection]);

  useEffect(() => {
    if (!compactLayout) return;
    input.onLibrary(false);
    input.onInspector(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compactLayout]);
}

interface RunnerInput {
  host: ComposerHost;
  selectedName: string;
  blueprintName: string;
  blueprintDefinition: unknown;
  setSubmitting(value: boolean): void;
  setFeedback(value: ComposerFeedback | undefined): void;
  setPendingSelection(value: string | undefined): void;
}

function createRunner(input: RunnerInput) {
  return async (action: ComposerAction): Promise<void> => {
    const targetName = input.blueprintName.trim();
    input.setSubmitting(true);
    input.setFeedback(undefined);
    try {
      if (action === "delete") {
        await input.host.onDelete(input.selectedName);
        input.setFeedback(DELETE_FEEDBACK);
        return;
      }
      const result = await runRemote(input, action, targetName);
      if (action === "save") input.setPendingSelection(result.name);
      input.setFeedback(feedbackFor(action));
    } catch (error) {
      input.setFeedback(errorFeedback(error));
    } finally {
      input.setSubmitting(false);
    }
  };
}

function runRemote(
  input: RunnerInput,
  action: Exclude<ComposerAction, "delete">,
  targetName: string,
): Promise<StrategyBlueprintResult> {
  return action === "save"
    ? input.host.onSave(targetName, input.blueprintDefinition)
    : input.host.onPreflight(targetName, input.blueprintDefinition);
}
