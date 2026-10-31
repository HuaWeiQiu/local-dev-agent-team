import { Card, SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";
import type { RunUsageBreakdown, UsageLine } from "../../types";
import { formatCost, formatDuration } from "./format";

const head = "bd-b px-3 py-2 text-left text-2xs font-medium uppercase tracking-wider text-muted";
const cell = "bd-b px-3 py-2 text-xs text-ink-2 tabular-nums";

function Table({ title, rows }: { title: string; rows: Array<{ key: string; label: string; sub?: string; line: UsageLine }> }) {
  if (rows.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <header className="bd-b px-4 py-3">
        <SectionTitle>{title}</SectionTitle>
      </header>
      <div className="scroll-thin overflow-x-auto">
        <table aria-label={title} className="w-full min-w-[520px] border-collapse">
          <thead>
            <tr>
              <th scope="col" className={head}>名称</th>
              <th scope="col" className={cn(head, "text-right")}>调用</th>
              <th scope="col" className={cn(head, "text-right")}>失败</th>
              <th scope="col" className={cn(head, "text-right")}>Token 入/出</th>
              <th scope="col" className={cn(head, "text-right")}>耗时</th>
              <th scope="col" className={cn(head, "text-right")}>成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label, sub, line }) => (
              <tr key={key}>
                <th scope="row" className={cn(cell, "text-left font-medium text-ink")}>
                  {label}
                  {sub ? <small className="ml-1.5 font-normal text-muted">{sub}</small> : null}
                </th>
                <td className={cn(cell, "text-right")}>{line.invocations}</td>
                <td className={cn(cell, "text-right", line.failures > 0 && "text-danger-ink")}>{line.failures}</td>
                <td className={cn(cell, "text-right")}>{line.inputTokens.toLocaleString()} / {line.outputTokens.toLocaleString()}</td>
                <td className={cn(cell, "text-right")}>{formatDuration(line.durationMs)}</td>
                <td className={cn(cell, "text-right")}>{formatCost(line.costUsd, line.costReported)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function CostView({ usage }: { usage: RunUsageBreakdown }) {
  const { total } = usage;
  return (
    <div className="flex flex-col gap-4">
      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line p-0 sm:grid-cols-4">
        {[
          ["成本", formatCost(total.costUsd, total.costReported)],
          ["调用", `${total.invocations}${total.failures > 0 ? `（失败 ${total.failures}）` : ""}`],
          ["Token 入/出", `${total.inputTokens.toLocaleString()} / ${total.outputTokens.toLocaleString()}`],
          ["耗时", formatDuration(total.durationMs)],
        ].map(([label, value]) => (
          <div key={label} className="bg-surface px-4 py-3">
            <SectionTitle>{label}</SectionTitle>
            <strong className="mt-1 block text-lg font-semibold tabular-nums text-ink">{value}</strong>
          </div>
        ))}
      </Card>
      <Table title="按角色" rows={usage.byRole.map((line) => ({ key: line.role, label: line.role, line }))} />
      <Table
        title="按任务"
        rows={[
          ...usage.byTask.map((line) => ({ key: line.taskId, label: line.taskId, line })),
          ...(usage.unattributed.invocations > 0
            ? [{ key: "_run", label: "运行级", sub: "规划 / 顾问 / 终审", line: usage.unattributed }]
            : []),
        ]}
      />
      <Table
        title="按模型配置"
        rows={usage.byProfile.map((line) => ({ key: `${line.profile}/${line.model}`, label: line.profile, sub: line.model, line }))}
      />
    </div>
  );
}
