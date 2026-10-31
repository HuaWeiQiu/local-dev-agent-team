import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { cn } from "../../../ui/cn";
import { commitLabel, taskSubtitle, type EvidenceCell } from "./model";
import type { RunEvidence } from "../../../types";

type TaskEvidence = RunEvidence["tasks"][number];

const CELL_TONE: Record<EvidenceCell["verdict"], string> = {
  pass: "text-success-ink",
  fail: "text-danger-ink",
  pending: "text-muted",
};

const CELL_ICON = {
  pass: CheckCircle2,
  fail: XCircle,
  pending: CircleDashed,
} as const;

export function EvidenceValue({ cell }: { cell: EvidenceCell }) {
  const Icon = CELL_ICON[cell.verdict];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap font-medium",
        CELL_TONE[cell.verdict],
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {cell.label}
    </span>
  );
}

export function TaskEvidenceRow({
  task,
  body,
  cells,
}: {
  task: TaskEvidence;
  body: string;
  cells: { quality: EvidenceCell; review: EvidenceCell; test: EvidenceCell };
}) {
  return (
    <tr className="transition-colors hover:bg-surface-2">
      <td className={cn(body, "max-w-0 w-[38%]")}>
        <strong className="block truncate text-sm font-medium text-ink" title={task.title}>
          {task.title}
        </strong>
        <small className="block truncate text-2xs text-muted">{taskSubtitle(task)}</small>
      </td>
      <td className={body}>
        <EvidenceValue cell={cells.quality} />
      </td>
      <td className={body}>
        <EvidenceValue cell={cells.review} />
      </td>
      <td className={body}>
        <EvidenceValue cell={cells.test} />
      </td>
      <td className={body}>
        <code className="text-2xs text-muted">{commitLabel(task)}</code>
      </td>
    </tr>
  );
}
