import { Hand } from "lucide-react";
import { Badge } from "../../ui/badge";
import { Card, SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";
import type { Transcript, TranscriptSummary } from "../../types";
import { EmptyState } from "../EmptyState";
import { TranscriptBody } from "./TranscriptBody";
import { formatDuration } from "./format";
import { useTranscriptContent, useTranscriptSelection } from "./useTranscript";

interface TranscriptViewProps {
  transcripts: TranscriptSummary[];
  taskId?: string | undefined;
  onLoad(id: string): Promise<Transcript>;
}

/** The line under the role: which task, which artifact, how long it took. */
function invocationSubtitle(item: TranscriptSummary): string {
  const task = item.taskId ? `${item.taskId} · ` : "";
  const duration = item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : "";
  return `${task}${item.artifactKey.split("/").slice(-2).join("/")}${duration}`;
}

function InvocationButton({
  item,
  selected,
  onSelect,
}: {
  item: TranscriptSummary;
  selected: boolean;
  onSelect(id: string): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(item.id)}
      className={cn(
        "w-full cursor-pointer rounded-md px-2.5 py-2 text-left focus-ring",
        selected ? "bg-accent-soft" : "hover:bg-surface-2",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
        {item.role ?? "agent"}
        {item.live && <Hand aria-label="实时会话" className="size-3 text-accent" />}
        {item.success === false && <Badge tone="danger">失败</Badge>}
      </span>
      <small className="mt-0.5 block break-all text-2xs text-muted">{invocationSubtitle(item)}</small>
    </button>
  );
}

function InvocationList({
  items,
  selected,
  onSelect,
}: {
  items: TranscriptSummary[];
  selected: string | undefined;
  onSelect(id: string): void;
}) {
  return (
    <Card className="max-h-[60vh] overflow-y-auto p-1.5 scroll-thin">
      <ul aria-label="智能体调用" className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <InvocationButton item={item} selected={item.id === selected} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The list of invocations on the left, the conversation they recorded on the right. */
export function TranscriptView({ transcripts, taskId, onLoad }: TranscriptViewProps) {
  const visible = taskId ? transcripts.filter((item) => item.taskId === taskId) : transcripts;
  const { selected, select } = useTranscriptSelection(visible);
  const { transcript, error } = useTranscriptContent(selected, onLoad);

  if (visible.length === 0) {
    return <EmptyState size="inline" title="还没有智能体对话记录" hint="智能体开始工作后，这里会出现它们的消息和工具调用。" />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <InvocationList items={visible} selected={selected} onSelect={select} />
      <Card className="min-w-0 p-4">
        <SectionTitle>对话</SectionTitle>
        <TranscriptBody transcript={transcript} error={error} />
      </Card>
    </div>
  );
}
