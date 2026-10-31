import { useMemo, useState } from "react";
import { presentArchitecture } from "../../architecture";
import type { ArchitectureDesign, RepoTrace, TaskRunState } from "../../types";
import { SequenceDiagram } from "./SequenceDiagram";
import { focusOf, neighborhoodOf, stepsFor, traceLeaves } from "./diagram/model";
import { BoxLayer, DiagramHeader, EdgeLayer, TraceIndex, ViewSwitch } from "./diagram/sections";

interface ArchitectureDiagramProps {
  tasks: TaskRunState[];
  design?: ArchitectureDesign;
  repoTrace?: RepoTrace;
  selectedModuleId?: string;
  onSelectModule(id: string): void;
  onClearModule?(): void;
}

export function ArchitectureDiagram({
  tasks,
  design,
  repoTrace,
  selectedModuleId,
  onSelectModule,
  onClearModule,
}: ArchitectureDiagramProps) {
  const presentation = useMemo(() => presentArchitecture(tasks, design), [tasks, design]);
  const [view, setView] = useState<"structure" | "sequence">("structure");
  const diagram = presentation.diagram;
  if (diagram.boxes.length === 0) return null;

  const boxOf = new Map(diagram.boxes.map((box) => [box.id, box]));
  const nameOf = (id: string): string => boxOf.get(id)?.label ?? id;
  const focused = focusOf(diagram, selectedModuleId);
  const neighborhood = neighborhoodOf(diagram, focused);
  const steps = stepsFor(presentation, focused, neighborhood);
  const leaves = traceLeaves(repoTrace);

  return (
    <section aria-label="系统架构图" className="bd-b bg-surface px-4 py-3 md:px-6">
      <DiagramHeader source={presentation.source} summary={presentation.summary} />
      {repoTrace && leaves.length > 0 && (
        <TraceIndex
          trace={repoTrace}
          diagram={diagram}
          focused={focused}
          onSelectModule={onSelectModule}
        />
      )}
      <ViewSwitch
        view={view}
        focused={focused}
        focusedName={focused ? nameOf(focused) : undefined}
        onSelectView={setView}
        onClearModule={onClearModule}
      />
      {view === "sequence" ? (
        <SequenceDiagram steps={steps} nameOf={nameOf} onSelect={onSelectModule} />
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <div className="relative" style={{ width: diagram.width, height: diagram.height }}>
            <EdgeLayer
              diagram={diagram}
              boxOf={boxOf}
              focused={focused}
              neighborhood={neighborhood}
            />
            <BoxLayer
              boxes={diagram.boxes}
              selectedModuleId={selectedModuleId}
              focused={focused}
              neighborhood={neighborhood}
              onSelectModule={onSelectModule}
            />
          </div>
        </div>
      )}
    </section>
  );
}
