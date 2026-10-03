import { Plus, Trash2 } from "lucide-react";
import type { Task } from "../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input, Textarea } from "../ui/form";

export interface EditablePlan {
  summary: string;
  tasks: Task[];
}

interface PlanEditorProps {
  plan: EditablePlan;
  onChange(plan: EditablePlan): void;
  disabled?: boolean;
}

function splitList(value: string, separator: RegExp): string[] {
  return value.split(separator).map((item) => item.trim()).filter(Boolean);
}

export function nextTaskId(tasks: Task[]): string {
  const used = new Set(tasks.map((task) => task.id));
  for (let index = tasks.length + 1; ; index += 1) {
    const candidate = `T${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Returns a human-readable problem with the draft, or undefined when it can be submitted. */
export function planDraftProblem(plan: EditablePlan): string | undefined {
  if (!plan.summary.trim()) return "计划摘要不能为空";
  if (plan.tasks.length === 0) return "计划至少需要一个任务";
  const ids = new Set(plan.tasks.map((task) => task.id));
  for (const task of plan.tasks) {
    if (!task.title.trim()) return `任务 ${task.id} 缺少标题`;
    if (!task.description.trim()) return `任务 ${task.id} 缺少说明`;
    if (task.ownedPaths.length === 0) return `任务 ${task.id} 至少需要一个负责路径`;
    const missing = task.dependsOn.find((dependency) => !ids.has(dependency) || dependency === task.id);
    if (missing) return `任务 ${task.id} 依赖了不存在的任务 ${missing}`;
  }
  return undefined;
}

export function PlanEditor({ plan, onChange, disabled }: PlanEditorProps) {
  const update = (index: number, patch: Partial<Task>) => {
    onChange({ ...plan, tasks: plan.tasks.map((task, position) => (position === index ? { ...task, ...patch } : task)) });
  };
  const remove = (index: number) => {
    const removed = plan.tasks[index]!;
    onChange({
      ...plan,
      tasks: plan.tasks
        .filter((_, position) => position !== index)
        .map((task) => ({ ...task, dependsOn: task.dependsOn.filter((dependency) => dependency !== removed.id) })),
    });
  };
  const add = () => {
    onChange({
      ...plan,
      tasks: [
        ...plan.tasks,
        {
          id: nextTaskId(plan.tasks),
          title: "",
          description: "",
          dependsOn: [],
          ownedPaths: [],
          acceptanceCommands: [],
          profile: null,
        },
      ],
    });
  };

  return (
    <div className="flex flex-col gap-3" aria-label="计划编辑器">
      <Field label="计划摘要" htmlFor="plan-summary">
        <Input id="plan-summary" value={plan.summary} disabled={disabled} onChange={(event) => onChange({ ...plan, summary: event.target.value })} />
      </Field>
      {plan.tasks.map((task, index) => (
        <fieldset key={task.id} className="bd m-0 flex flex-col gap-2 rounded-lg p-3" disabled={disabled}>
          <legend className="flex items-center gap-2 px-1 text-xs font-semibold text-ink-2">
            任务 {task.id}
            {task.acceptanceCommands.length > 0 ? <Badge tone="info">{task.acceptanceCommands.length} 条验收命令</Badge> : null}
          </legend>
          <Field label="标题" htmlFor={`plan-title-${task.id}`}>
            <Input id={`plan-title-${task.id}`} value={task.title} onChange={(event) => update(index, { title: event.target.value })} />
          </Field>
          <Field label="说明" htmlFor={`plan-desc-${task.id}`}>
            <Textarea id={`plan-desc-${task.id}`} rows={3} value={task.description} onChange={(event) => update(index, { description: event.target.value })} />
          </Field>
          <Field label="负责路径（每行一个，可用通配符）" htmlFor={`plan-paths-${task.id}`}>
            <Textarea
              id={`plan-paths-${task.id}`}
              rows={2}
              defaultValue={task.ownedPaths.join("\n")}
              onChange={(event) => update(index, { ownedPaths: splitList(event.target.value, /\r?\n/) })}
            />
          </Field>
          <Field label="依赖任务（逗号分隔）" htmlFor={`plan-deps-${task.id}`}>
            <Input
              id={`plan-deps-${task.id}`}
              defaultValue={task.dependsOn.join(", ")}
              onChange={(event) => update(index, { dependsOn: splitList(event.target.value, /[,，\s]+/) })}
            />
          </Field>
          <div>
            <Button variant="danger" size="sm" onClick={() => remove(index)}>
              <Trash2 />删除任务
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button size="sm" onClick={add} disabled={disabled}>
          <Plus />添加任务
        </Button>
      </div>
    </div>
  );
}
