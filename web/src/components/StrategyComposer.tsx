import { Workflow } from "lucide-react";
import type {
  PublicConfig,
  StrategyBlueprintDefinition,
  StrategyBlueprintResult,
} from "../types";
import { ComposerToolbar } from "./strategy/ComposerToolbar";
import { StrategyCanvas } from "./strategy/composer/sections";
import { useStrategyComposer } from "./strategy/composer/useStrategyComposer";
import { InspectorPanel } from "./strategy/InspectorPanel";
import { LibraryPanel } from "./strategy/LibraryPanel";

interface StrategyComposerProps {
  config: PublicConfig;
  onPreflight(name: string, definition: StrategyBlueprintDefinition): Promise<StrategyBlueprintResult>;
  onSave(name: string, definition: StrategyBlueprintDefinition): Promise<StrategyBlueprintResult>;
  onDelete(name: string): Promise<void>;
  onLaunch(name: string): void;
}

export function StrategyComposer(props: StrategyComposerProps) {
  if (Object.keys(props.config.strategies.definitions).length === 0) {
    return (
      <section aria-label="策略编排器" className="grid h-full place-items-center bg-background p-6">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-ink">
            <Workflow className="size-5" />
          </span>
          <strong className="text-base font-semibold text-ink">还没有可编排的策略</strong>
          <span className="text-sm leading-relaxed text-muted">
            在项目配置中定义策略后，可在这里可视化调整阶段与限额，并保存为自定义蓝图。
          </span>
        </div>
      </section>
    );
  }
  return <StrategyWorkspace {...props} />;
}

function StrategyWorkspace(props: StrategyComposerProps) {
  const model = useStrategyComposer(props);
  const { workspace } = model;

  return (
    <section
      className="strategy-composer @container relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background"
      aria-label="策略编排器"
      aria-busy={model.submitting}
    >
      <ComposerToolbar
        strategyNames={model.strategyNames}
        selectedName={model.selectedName}
        libraryOpen={model.libraryOpen}
        inspectorOpen={model.inspectorOpen}
        submitting={model.submitting}
        dirty={model.dirty}
        canSubmit={model.blueprintName.trim().length > 0}
        feedback={model.feedback}
        onSelect={workspace.selectStrategy}
        onToggleLibrary={workspace.setLibraryOpen}
        onToggleInspector={workspace.setInspectorOpen}
        onPreflight={() => void workspace.run("preflight")}
        onSave={() => void workspace.run("save")}
        onLaunch={workspace.launch}
      />

      <div className="relative min-h-0 flex-1">
        <StrategyCanvas
          graph={model.graph}
          topology={model.topology}
          draft={model.draft}
          palette={model.palette}
          feedback={model.feedback}
          onSelectStage={workspace.setInspectorOpen}
        />
        <ComposerScrim
          visible={model.compactLayout && model.panelOpen}
          onDismiss={workspace.closePanels}
        />
        <LibraryPanel
          open={model.libraryOpen}
          compact={model.compactLayout}
          strategyNames={model.strategyNames}
          definitions={props.config.strategies.definitions}
          selectedName={model.selectedName}
          planApproval={model.draft.planApproval}
          submitting={model.submitting}
          onSelect={workspace.selectStrategy}
          onTogglePlanApproval={() =>
            workspace.updateDraft((current) => ({ ...current, planApproval: !current.planApproval }))
          }
          onClose={() => workspace.setLibraryOpen()}
        />
        <InspectorPanel
          open={model.inspectorOpen}
          compact={model.compactLayout}
          config={props.config}
          definition={model.definition}
          selectedName={model.selectedName}
          draft={model.draft}
          blueprintName={model.blueprintName}
          submitting={model.submitting}
          onBlueprintNameChange={workspace.setBlueprintName}
          onDraft={workspace.updateDraft}
          onReset={workspace.resetDraft}
          onDelete={() => void workspace.run("delete")}
          onClose={() => workspace.setInspectorOpen()}
        />
      </div>
    </section>
  );
}

function ComposerScrim({ visible, onDismiss }: { visible: boolean; onDismiss(): void }) {
  if (!visible) return null;
  return <div aria-hidden className="absolute inset-0 z-10 bg-scrim" onClick={onDismiss} />;
}
