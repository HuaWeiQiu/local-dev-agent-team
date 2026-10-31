import { presentArchitecture } from "../../architecture";
import type { ArchitectureDesign, RepoTrace, TaskRunState } from "../../types";
import {
  ModuleHeader,
  ModulePaths,
  ModuleRelations,
  ModuleTasks,
} from "./module/sections";
import { incomingEdges, moduleById, outgoingEdges } from "./module/model";

interface ModuleDetailProps {
  tasks: TaskRunState[];
  design?: ArchitectureDesign;
  repoTrace?: RepoTrace;
  moduleId: string;
  onSelectTask(task: TaskRunState): void;
  onSelectModule(id: string): void;
  onClearModule?(): void;
}

export function ModuleDetail({
  tasks,
  design,
  repoTrace,
  moduleId,
  onSelectTask,
  onSelectModule,
  onClearModule,
}: ModuleDetailProps) {
  const diagram = presentArchitecture(tasks, design).diagram;
  const module = moduleById(diagram, moduleId);
  if (!module) return null;
  const indexed = repoTrace?.nodes.find((node) => node.id === module.nodeId)?.path;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ModuleHeader module={module} onClearModule={onClearModule} />
      <ModulePaths module={module} indexed={indexed} />
      <ModuleRelations
        diagram={diagram}
        incoming={incomingEdges(diagram, moduleId)}
        outgoing={outgoingEdges(diagram, moduleId)}
        onSelectModule={onSelectModule}
      />
      <ModuleTasks tasks={module.tasks} onSelectTask={onSelectTask} />
    </div>
  );
}
