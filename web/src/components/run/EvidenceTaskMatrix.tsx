import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import type { RunEvidence } from "../../types";
import { Card, SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";

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
        <span className="shrink-0 text-xs text-muted">{tasks.length} 个任务</span>
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
                  <EvidenceValue value={task.qualityPassed === undefined ? "待执行" : task.qualityPassed ? "通过" : "失败"} passing={task.qualityPassed} />
                </td>
                <td className={bodyCell}>
                  <EvidenceValue value={task.reviewVerdict ?? "待执行"} passing={task.reviewVerdict === "approve" ? true : task.reviewVerdict ? false : undefined} />
                </td>
                <td className={bodyCell}>
                  <EvidenceValue value={task.testVerdict ?? "待执行"} passing={task.testVerdict === "approve" ? true : task.testVerdict ? false : undefined} />
                </td>
                <td className={bodyCell}>
                  <code className="text-2xs text-muted">{task.commit?.slice(0, 9) ?? "-"}</code>
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

function EvidenceValue({ value, passing }: { value: string; passing: boolean | undefined }) {
  const Icon = passing === true ? CheckCircle2 : passing === false ? XCircle : CircleDashed;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap font-medium", passing === true ? "text-success-ink" : passing === false ? "text-danger-ink" : "text-muted")}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {value}
    </span>
  );
}
