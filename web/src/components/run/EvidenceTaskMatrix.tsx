import type { RunEvidence } from "../../types";
import { Card, SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";
import { commitLabel, qualityCell, taskCountLabel, verdictCell } from "./evidence/model";
import { EvidenceValue } from "./evidence/sections";

const headCell = "bd-b bg-surface-2 px-3 py-2 text-left text-2xs font-medium uppercase tracking-wider text-muted first:pl-4 last:pr-4";
const bodyCell = "bd-b px-3 py-2.5 align-middle first:pl-4 last:pr-4";

export function EvidenceTaskMatrix({ tasks }: { tasks: RunEvidence["tasks"] }) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <header className="bd-b flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <SectionTitle>任务证据</SectionTitle>
          <h2 className="m-0 mt-0.5 text-sm font-semibold text-ink">任务交付矩阵</h2>
        </div>
        <span className="shrink-0 text-xs text-muted">{taskCountLabel(tasks.length)}</span>
      </header>
      <div className="scroll-thin relative overflow-x-auto">
        <table aria-label="任务交付矩阵" className="w-full min-w-[560px] border-collapse text-xs">
          <thead>
            <tr>
              <th scope="col" className={headCell}>任务</th>
              <th scope="col" className={headCell}>质量</th>
              <th scope="col" className={headCell}>审查</th>
              <th scope="col" className={headCell}>测试</th>
              <th scope="col" className={headCell}>提交</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} className="transition-colors hover:bg-surface-2">
                <td className={cn(bodyCell, "max-w-0 w-[38%]")}>
                  <strong className="block truncate text-sm font-medium text-ink" title={task.title}>{task.title}</strong>
                  <small className="block truncate text-2xs text-muted">{task.id} · {task.status}</small>
                </td>
                <td className={bodyCell}>
                  <EvidenceValue cell={qualityCell(task)} />
                </td>
                <td className={bodyCell}>
                  <EvidenceValue cell={verdictCell(task.reviewVerdict)} />
                </td>
                <td className={bodyCell}>
                  <EvidenceValue cell={verdictCell(task.testVerdict)} />
                </td>
                <td className={bodyCell}>
                  <code className="text-2xs text-muted">{commitLabel(task)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tasks.length === 0 && <p className="m-0 px-4 py-8 text-center text-sm text-muted">还没有任务证据</p>}
      </div>
    </Card>
  );
}
