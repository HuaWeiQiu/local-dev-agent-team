import { Bot, FileText, ListChecks, MessageSquareText, Repeat2, Route, ScrollText, TextCursorInput } from "lucide-react";
import type { StageBrief } from "../../architecture";
import type { TaskRunState } from "../../types";
import { formatRelative } from "../../time";
import { Badge } from "../../ui/badge";
import { TaskStatusPill } from "../../ui/status";
import { Definition, DefinitionList, InspectorSection } from "../run/inspector-parts";

const STATE_LABEL = {
  current: "进行中",
  done: "已完成",
  failed: "在此停止",
  skipped: "已跳过",
  pending: "未开始",
} as const;

interface StageDetailProps {
  brief: StageBrief;
  onSelectTask(task: TaskRunState): void;
}

export function StageDetail({ brief, onSelectTask }: StageDetailProps) {
  const { stage, headline, hint, history, agents, liveText, artifact, input, retries, ledger, tasks } = brief;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section className="bd-b px-4 py-4">
        <span className="text-2xs font-medium uppercase tracking-wider text-muted">{STATE_LABEL[stage.state]}</span>
        <h3 className="m-0 mt-1 text-base font-semibold text-ink">{stage.label}</h3>
        <p className="m-0 mt-2 text-sm leading-relaxed text-ink-2">{headline}</p>
        <p className="m-0 mt-2 text-xs leading-relaxed text-muted">{hint}</p>
      </section>
      {input && (
        <InspectorSection icon={TextCursorInput} title="输入">
          <p className="m-0 whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{input}</p>
        </InspectorSection>
      )}
      {artifact && (
        <InspectorSection icon={FileText} title={`结果 · ${artifact.title}`}>
          <p className="m-0 whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{artifact.body}</p>
        </InspectorSection>
      )}
      {retries !== undefined && retries > 0 && (
        <InspectorSection icon={Repeat2} title="重试">
          <p className="m-0 text-xs text-ink-2">这一步额外尝试了 {retries} 次（返工、不稳定重跑，或请教之后再试）。</p>
        </InspectorSection>
      )}
      {ledger.length > 0 && (
        <InspectorSection icon={ScrollText} title="这一步的事件">
          <DefinitionList>
            {ledger.map((entry) => (
              <Definition key={`${entry.at}-${entry.label}-${entry.detail ?? ""}`} term={formatRelative(entry.at)}>
                <span className="text-ink">{entry.label}</span>
                {entry.detail ? <span className="mt-0.5 block text-muted">{entry.detail}</span> : null}
              </Definition>
            ))}
          </DefinitionList>
        </InspectorSection>
      )}
      {liveText && (
        <InspectorSection icon={MessageSquareText} title="正在输出">
          <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-ink-2">{liveText}</pre>
        </InspectorSection>
      )}
      {agents.length > 0 && (
        <InspectorSection icon={Bot} title="这一步的智能体">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {agents.map((agent) => (
              <li key={`${agent.role}-${agent.label}`} className="flex items-center gap-2 text-sm">
                <Badge tone={agent.status === "running" ? "active" : agent.status === "failed" ? "danger" : "success"}>
                  {agent.status === "running" ? "执行中" : agent.status === "failed" ? "失败" : "完成"}
                </Badge>
                <span className="text-ink">{agent.label}</span>
                {agent.note && <span className="truncate text-xs text-muted">{agent.note}</span>}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {ledger.length === 0 && history.length > 0 && (
        <InspectorSection icon={Route} title="过程记录">
          <DefinitionList>
            {history.map((entry) => (
              <Definition key={`${entry.at}-${entry.message}`} term={formatRelative(entry.at)}>
                {entry.message}
              </Definition>
            ))}
          </DefinitionList>
        </InspectorSection>
      )}
      {tasks.length > 0 && (
        <InspectorSection icon={ListChecks} title="相关任务">
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
      )}
    </div>
  );
}
