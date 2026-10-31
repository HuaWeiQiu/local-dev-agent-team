import { CheckCircle2, FileCode2, GitBranch, GitCompare, ShieldAlert, TerminalSquare } from "lucide-react";
import { acceptanceSummary, taskKind, taskKindLabel } from "../../../plan-completeness";
import { humanizeFailure, profileDisplayName } from "../../../presentation";
import type { RunState, TaskDiff, TaskRunState } from "../../../types";
import { cn } from "../../../ui/cn";
import { TaskDiffSection } from "../../insights/DiffView";
import {
  Definition,
  DefinitionList,
  InlineError,
  InspectorCode,
  InspectorSection,
  Verdict,
  describeRunFailure,
} from "../inspector-parts";
import {
  commandText,
  dependsLabel,
  evidenceLabel,
  findingLocation,
  hasReview,
  showRunError,
  taskProfile,
} from "./task-model";

export function TaskHeader({ task }: { task: TaskRunState }) {
  return (
    <section className="bd-b px-4 py-4">
      <code className="block break-all text-2xs text-accent-ink">{task.task.id}</code>
      <h3 className="m-0 mt-1.5 break-words text-base font-semibold leading-snug text-ink">
        {task.task.title}
      </h3>
      <p className="m-0 mt-2 break-words text-xs leading-relaxed text-ink-2">
        {task.task.description}
      </p>
    </section>
  );
}

export function TaskContract({ task }: { task: TaskRunState }) {
  return (
    <InspectorSection icon={FileCode2} title="计划合同">
      <DefinitionList>
        <Definition term="类型">{taskKindLabel(taskKind(task.task))}</Definition>
        <Definition term="依赖">{dependsLabel(task.task)}</Definition>
        <Definition term="验收">{acceptanceSummary(task.task)}</Definition>
        <Definition term="证据">{evidenceLabel(task.task)}</Definition>
      </DefinitionList>
    </InspectorSection>
  );
}

export function TaskExecution({ task }: { task: TaskRunState }) {
  const profile = taskProfile(task);
  return (
    <InspectorSection icon={GitBranch} title="执行">
      <DefinitionList>
        <Definition term="配置" {...(profile ? { title: profile } : {})}>
          {profileDisplayName(profile ?? "策略分配")}
        </Definition>
        {task.task.batchKey ? (
          <Definition term="批次">
            <InspectorCode>{task.task.batchKey}</InspectorCode>
          </Definition>
        ) : null}
        <Definition term="尝试次数">{task.attempts}</Definition>
        {task.branch && (
          <Definition term="分支">
            <InspectorCode>{task.branch}</InspectorCode>
          </Definition>
        )}
        {task.commit && (
          <Definition term="提交">
            <InspectorCode>{task.commit.slice(0, 10)}</InspectorCode>
          </Definition>
        )}
      </DefinitionList>
    </InspectorSection>
  );
}

export function TaskDiffBlock({ task, onLoadDiff }: { task: TaskRunState; onLoadDiff: (taskId: string) => Promise<TaskDiff> }) {
  if (task.attempts <= 0) return null;
  return (
    <InspectorSection icon={GitCompare} title="改动">
      <TaskDiffSection taskId={task.task.id} onLoad={onLoadDiff} />
    </InspectorSection>
  );
}

export function TaskPaths({ task }: { task: TaskRunState }) {
  return (
    <InspectorSection icon={FileCode2} title="负责路径">
      <div className="flex flex-wrap gap-1.5">
        {task.task.ownedPaths.map((item) => (
          <code key={item} className="bd break-all rounded-sm bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-2">
            {item}
          </code>
        ))}
      </div>
    </InspectorSection>
  );
}

export function TaskQuality({ task }: { task: TaskRunState }) {
  return (
    <InspectorSection icon={TerminalSquare} title="质量命令">
      {task.quality ? <QualityCommands task={task} /> : <p className="m-0 text-xs text-muted">尚未执行</p>}
    </InspectorSection>
  );
}

function QualityCommands({ task }: { task: TaskRunState }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {task.quality!.commands.map((command, index) => (
        <QualityCommandRow key={`${command.spec.command}-${index}`} command={command} />
      ))}
    </ul>
  );
}

function QualityCommandRow({
  command,
}: {
  command: NonNullable<TaskRunState["quality"]>["commands"][number];
}) {
  const passed = command.exitCode === 0;
  const Icon = passed ? CheckCircle2 : ShieldAlert;
  const text = commandText(command);
  return (
    <li className="flex items-center gap-2">
      <Icon
        aria-label={passed ? "通过" : "失败"}
        className={cn("size-3.5 shrink-0", passed ? "text-success" : "text-danger")}
      />
      <code className="min-w-0 flex-1 truncate text-2xs text-ink-2" title={text}>
        {text}
      </code>
      <small className="shrink-0 text-2xs tabular-nums text-muted">{command.durationMs} ms</small>
    </li>
  );
}

export function TaskReview({ task }: { task: TaskRunState }) {
  if (!hasReview(task)) return null;
  return (
    <InspectorSection icon={ShieldAlert} title="审查结论">
      {task.review && (
        <Verdict label="代码审查" verdict={task.review.verdict} summary={task.review.summary} />
      )}
      {task.test && <Verdict label="测试审查" verdict={task.test.verdict} summary={task.test.summary} />}
      {task.review?.findings.map((finding, index) => (
        <FindingCard key={`${finding.path}-${index}`} finding={finding} />
      ))}
    </InspectorSection>
  );
}

function FindingCard({
  finding,
}: {
  finding: NonNullable<TaskRunState["review"]>["findings"][number];
}) {
  return (
    <div className="mt-2 flex flex-col gap-1 rounded-md bg-danger-soft px-3 py-2.5 text-xs">
      <strong className="text-2xs font-semibold uppercase tracking-wider text-danger-ink">
        {finding.severity}
      </strong>
      <span className="break-words leading-relaxed text-ink-2">{finding.message}</span>
      <code className="break-all text-2xs text-muted">{findingLocation(finding)}</code>
    </div>
  );
}

export function TaskErrors({ task, run }: { task: TaskRunState; run: RunState | undefined }) {
  return (
    <>
      {task.error && <InlineError>{humanizeFailure(task.error)}</InlineError>}
      {run && showRunError(task.error, run.error) && (
        <InlineError>{describeRunFailure(run)}</InlineError>
      )}
    </>
  );
}
