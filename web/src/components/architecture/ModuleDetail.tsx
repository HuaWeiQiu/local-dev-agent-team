import { ArrowDownRight, ArrowUpRight, FolderTree, ListChecks } from "lucide-react";
import { ARCHITECTURE_KIND_LABEL, ARCHITECTURE_RELATION_LABEL, presentArchitecture, type ModuleStatus } from "../../architecture";
import type { ArchitectureDesign, TaskRunState } from "../../types";
import { TaskStatusPill } from "../../ui/status";
import { InspectorSection } from "../run/inspector-parts";

const STATUS_LABEL: Record<ModuleStatus, string> = {
  working: "进行中",
  blocked: "被阻塞",
  done: "已完成",
  pending: "未开始",
  mixed: "部分完成",
};

interface ModuleDetailProps {
  tasks: TaskRunState[];
  design?: ArchitectureDesign;
  moduleId: string;
  onSelectTask(task: TaskRunState): void;
  onSelectModule(id: string): void;
  onClearModule?(): void;
}

export function ModuleDetail({ tasks, design, moduleId, onSelectTask, onSelectModule, onClearModule }: ModuleDetailProps) {
  const diagram = presentArchitecture(tasks, design).diagram;
  const module = diagram.boxes.find((box) => box.id === moduleId);
  if (!module) return null;
  const nameOf = (id: string) => diagram.boxes.find((box) => box.id === id)?.label ?? id;
  const incoming = diagram.edges.filter((edge) => edge.to === moduleId);
  const outgoing = diagram.edges.filter((edge) => edge.from === moduleId);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section className="bd-b px-4 py-4">
        <span className="text-2xs font-medium uppercase tracking-wider text-muted">
          {module.kind ? `${ARCHITECTURE_KIND_LABEL[module.kind]} · ` : ""}
          {STATUS_LABEL[module.status]}
        </span>
        <h3 className="m-0 mt-1 text-base font-semibold text-ink">{module.label}</h3>
        <p className="m-0 mt-2 text-xs leading-relaxed text-ink-2">
          {module.responsibility ?? "这个元素来自任务路径的推断。点下面的任务看具体改动、门禁和评审。"}
        </p>
        {onClearModule && (
          <button type="button" onClick={onClearModule} className="mt-3 cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-ink hover:underline focus-ring">
            返回整个系统
          </button>
        )}
      </section>
      <InspectorSection icon={FolderTree} title="负责路径">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {module.paths.map((path) => (
            <li key={path}><code className="text-xs text-ink-2">{path}</code></li>
          ))}
        </ul>
      </InspectorSection>
      {(incoming.length > 0 || outgoing.length > 0) && (
        <InspectorSection icon={ArrowDownRight} title="上下游">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {incoming.map((edge) => (
              <li key={`in-${edge.from}`}>
                <button type="button" onClick={() => onSelectModule(edge.from)} className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-accent-ink hover:underline focus-ring">
                  <ArrowUpRight className="size-3" />上游 {nameOf(edge.from)}{edge.kind ? ` · ${ARCHITECTURE_RELATION_LABEL[edge.kind]}` : ""}
                </button>
              </li>
            ))}
            {outgoing.map((edge) => (
              <li key={`out-${edge.to}`}>
                <button type="button" onClick={() => onSelectModule(edge.to)} className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-accent-ink hover:underline focus-ring">
                  <ArrowDownRight className="size-3" />下游 {nameOf(edge.to)}{edge.kind ? ` · ${ARCHITECTURE_RELATION_LABEL[edge.kind]}` : ""}
                </button>
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      <InspectorSection icon={ListChecks} title="这个模块里的任务">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {module.tasks.map((task) => (
            <li key={task.task.id}>
              <button
                type="button"
                onClick={() => onSelectTask(task)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1.5 text-left hover:bg-surface-2 focus-ring"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{task.task.title}</span>
                <TaskStatusPill status={task.status} />
              </button>
            </li>
          ))}
        </ul>
      </InspectorSection>
    </div>
  );
}
