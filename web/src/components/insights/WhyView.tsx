import { cn } from "../../ui/cn";
import { Card, SectionTitle } from "../../ui/card";
import type { ExplainLine, RunExplanation } from "../../types";
import { toneDot, toneText } from "./format";

function Lines({ lines }: { lines: ExplainLine[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {lines.map((line, index) => (
        <li key={`${line.text}-${index}`} className="flex items-start gap-2 text-xs leading-relaxed">
          <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", toneDot[line.tone])} />
          <span className={cn("min-w-0 break-words", toneText[line.tone])}>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Every sentence comes from recorded gates, verdicts and ledger decisions, never from a model. */
export function WhyView({ explanation }: { explanation: RunExplanation }) {
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <SectionTitle>结论</SectionTitle>
        <p className={cn("m-0 mt-1.5 text-sm font-medium leading-snug", toneText[explanation.headline.tone])}>
          {explanation.headline.text}
        </p>
        {explanation.flow && (
          <p className="m-0 mt-2 text-xs text-muted">
            流程 {explanation.flow.template}（{explanation.flow.source}）
            {explanation.flow.reasons.length > 0 ? `：${explanation.flow.reasons.join("；")}` : ""}
          </p>
        )}
        {explanation.run.length > 0 && (
          <div className="bd-t mt-3 pt-3">
            <Lines lines={explanation.run} />
          </div>
        )}
      </Card>
      {explanation.tasks.map((task) => (
        <Card key={task.taskId} className="p-4">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <code className="text-2xs text-accent-ink">{task.taskId}</code>
            <strong className="text-sm text-ink">{task.title}</strong>
          </div>
          <p className={cn("m-0 mt-1 text-xs leading-relaxed", toneText[task.tone])}>{task.summary}</p>
          {task.lines.length > 0 && (
            <div className="bd-t mt-3 pt-3">
              <Lines lines={task.lines} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
