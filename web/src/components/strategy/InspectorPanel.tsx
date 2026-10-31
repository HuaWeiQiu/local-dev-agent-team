import { SlidersHorizontal } from "lucide-react";
import type { PublicConfig, StrategyDefinition } from "../../types";
import { DrawerPanel } from "./DrawerPanel";
import type { DraftUpdater, StrategyDraft } from "./draft";
import {
  BlueprintSection,
  LimitsSection,
  MorphologySection,
  PanelHeader,
  RolesSection,
  TopologySection,
} from "./inspector/sections";

export function InspectorPanel({
  open,
  compact,
  config,
  definition,
  selectedName,
  draft,
  blueprintName,
  submitting,
  onBlueprintNameChange,
  onDraft,
  onReset,
  onDelete,
  onClose,
}: InspectorPanelProps) {
  const custom = definition.source === "custom";
  const sections = { config, draft, submitting, onDraft };
  return (
    <DrawerPanel side="right" open={open} compact={compact} label="策略属性">
      <PanelHeader
        icon={<SlidersHorizontal />}
        custom={custom}
        selectedName={selectedName}
        submitting={submitting}
        onReset={onReset}
        onDelete={onDelete}
        onClose={onClose}
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto text-xs">
        <BlueprintSection
          blueprintName={blueprintName}
          custom={custom}
          submitting={submitting}
          onBlueprintNameChange={onBlueprintNameChange}
        />
        <TopologySection {...sections} />
        <LimitsSection {...sections} />
        <MorphologySection {...sections} />
        <RolesSection {...sections} />
      </div>
    </DrawerPanel>
  );
}

interface InspectorPanelProps {
  open: boolean;
  compact: boolean;
  config: PublicConfig;
  definition: StrategyDefinition;
  selectedName: string;
  draft: StrategyDraft;
  blueprintName: string;
  submitting: boolean;
  onBlueprintNameChange(name: string): void;
  onDraft: DraftUpdater;
  onReset(): void;
  onDelete(): void;
  onClose(): void;
}
