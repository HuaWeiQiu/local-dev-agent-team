import { ArrowDownRight, ArrowUpRight, FolderTree, ListChecks } from "lucide-react";
import type { ArchitectureDiagram, ArchitectureEdge, ArchitectureModule } from "../../../architecture";
import type { TaskRunState } from "../../../types";
import { TaskStatusPill } from "../../../ui/status";
import { InspectorSection } from "../../run/inspector-parts";
import { kindPrefix, labelOf, pathRows, relationSuffix, responsibilityOf } from "./model";

const STATUS_LABEL = {
  working: "进行中",
  blocked: "被阻塞",
  done: "已完成",
  pending: "未开始",
  mixed: "部分完成",
} as const;

export function ModuleHeader({
  module,
  onClearModule,
}: {
  module: ArchitectureModule;
  onClearModule: (() => void) | undefined;
}) {
  return (
    <section className="bd-b px-4 py-4">
      <span className="text-2xs font-medium uppercase tracking-wider text-muted">
        {kindPrefix(module.kind)}
        {STATUS_LABEL[module.status]}
      </span>
      <h3 className="m-0 mt-1 text-base font-semibold text-ink">{module.label}</h3>
      <p className="m-0 mt-2 text-xs leading-relaxed text-ink-2">{responsibilityOf(module)}</p>
      {onClearModule && (
        <button
          type="button"
          onClick={onClearModule}
          className="mt-3 cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-ink hover:underline focus-ring"
        >
          返回整个系统
        </button>
      )}
    </section>
  );
}

export function ModulePaths({
  module,
  indexed,
}: {
  module: ArchitectureModule;
  indexed: string | undefined;
}) {
  return (
    <InspectorSection icon={FolderTree} title="负责路径">
      <ul className="m-0 list-none divide-y p-0">
        {pathRows(module, indexed).map((row) => (
          <li
            key={`${row.label}-${row.value}`}
            className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 py-1.5"
          >
            <span className="text-2xs text-muted">{row.label}</span>
            <code className="truncate text-xs text-ink-2">{row.value}</code>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

export function ModuleRelations({
  diagram,
  incoming,
  outgoing,
  onSelectModule,
}: {
  diagram: ArchitectureDiagram;
  incoming: ArchitectureEdge[];
  outgoing: ArchitectureEdge[];
  onSelectModule(id: string): void;
}) {
  if (incoming.length === 0 && outgoing.length === 0) return null;
  return (
    <InspectorSection icon={ArrowDownRight} title="上下游">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {incoming.map((edge) => (
          <RelationLink
            key={`in-${edge.from}`}
            direction="上游"
            label={labelOf(diagram, edge.from)}
            kind={edge.kind}
            onClick={() => onSelectModule(edge.from)}
          />
        ))}
        {outgoing.map((edge) => (
          <RelationLink
            key={`out-${edge.to}`}
            direction="下游"
            label={labelOf(diagram, edge.to)}
            kind={edge.kind}
            onClick={() => onSelectModule(edge.to)}
          />
        ))}
      </ul>
    </InspectorSection>
  );
}

function RelationLink({
  direction,
  label,
  kind,
  onClick,
}: {
  direction: "上游" | "下游";
  label: string;
  kind: string | undefined;
  onClick(): void;
}) {
  const Icon = direction === "上游" ? ArrowUpRight : ArrowDownRight;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-accent-ink hover:underline focus-ring"
      >
        <Icon className="size-3" />
        {direction} {label}
        {relationSuffix(kind)}
      </button>
    </li>
  );
}

export function ModuleTasks({
  tasks,
  onSelectTask,
}: {
  tasks: ArchitectureModule["tasks"];
  onSelectTask(task: TaskRunState): void;
}) {
  return (
    <InspectorSection icon={ListChecks} title="这个模块里的任务">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {tasks.map((task) => (
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
  );
}
