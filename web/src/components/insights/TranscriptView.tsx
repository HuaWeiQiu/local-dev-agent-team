import { Bot, CircleAlert, CircleHelp, Hand, Terminal, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../ui/badge";
import { Card, SectionTitle } from "../../ui/card";
import { cn } from "../../ui/cn";
import type { Transcript, TranscriptEntry, TranscriptSummary } from "../../types";
import { EmptyState } from "../EmptyState";
import { formatDuration } from "./format";

interface TranscriptViewProps {
  transcripts: TranscriptSummary[];
  taskId?: string | undefined;
  onLoad(id: string): Promise<Transcript>;
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "turn") {
    return <li className="text-center text-2xs text-muted">{entry.text}</li>;
  }
  const Icon =
    entry.kind === "tool" ? Terminal
    : entry.kind === "operator" ? UserRound
    : entry.kind === "question" ? CircleHelp
    : entry.kind === "notice" ? CircleAlert
    : Bot;
  return (
    <li className="flex gap-2.5">
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", entry.kind === "operator" ? "text-accent" : "text-muted")} />
      <div className="min-w-0 flex-1">
        {(entry.label || entry.status) && (
          <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
            {entry.label && <Badge tone={entry.kind === "operator" ? "active" : "neutral"}>{entry.label}</Badge>}
            {entry.status && entry.status !== "completed" && (
              <Badge tone={entry.status === "failed" ? "danger" : "info"}>{entry.status}</Badge>
            )}
          </div>
        )}
        <pre
          className={cn(
            "m-0 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-ink-2",
            entry.kind === "tool" && "font-mono text-2xs text-muted",
          )}
        >
          {entry.text}
        </pre>
      </div>
    </li>
  );
}

export function TranscriptView({ transcripts, taskId, onLoad }: TranscriptViewProps) {
  const visible = taskId ? transcripts.filter((item) => item.taskId === taskId) : transcripts;
  const [selected, setSelected] = useState<string | undefined>(visible[0]?.id);
  const [transcript, setTranscript] = useState<Transcript>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!selected || !visible.some((item) => item.id === selected)) setSelected(visible[0]?.id);
  }, [visible, selected]);

  useEffect(() => {
    if (!selected) {
      setTranscript(undefined);
      return;
    }
    let current = true;
    setError(undefined);
    onLoad(selected).then(
      (value) => current && setTranscript(value),
      (cause: unknown) => current && setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      current = false;
    };
  }, [selected, onLoad]);

  if (visible.length === 0) {
    return <EmptyState size="inline" title="还没有智能体对话记录" hint="智能体开始工作后，这里会出现它们的消息和工具调用。" />;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="max-h-[60vh] overflow-y-auto p-1.5 scroll-thin">
        <ul aria-label="智能体调用" className="m-0 flex list-none flex-col gap-0.5 p-0">
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={item.id === selected}
                onClick={() => setSelected(item.id)}
                className={cn(
                  "w-full cursor-pointer rounded-md px-2.5 py-2 text-left focus-ring",
                  item.id === selected ? "bg-accent-soft" : "hover:bg-surface-2",
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                  {item.role ?? "agent"}
                  {item.live && <Hand aria-label="实时会话" className="size-3 text-accent" />}
                  {item.success === false && <Badge tone="danger">失败</Badge>}
                </span>
                <small className="mt-0.5 block break-all text-2xs text-muted">
                  {item.taskId ? `${item.taskId} · ` : ""}{item.artifactKey.split("/").slice(-2).join("/")}
                  {item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : ""}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="min-w-0 p-4">
        <SectionTitle>对话</SectionTitle>
        {error ? (
          <p role="alert" className="m-0 mt-2 text-xs text-danger-ink">{error}</p>
        ) : !transcript ? (
          <p role="status" className="m-0 mt-2 text-xs text-muted">正在读取…</p>
        ) : transcript.entries.length === 0 ? (
          <p className="m-0 mt-2 text-xs text-muted">这次调用没有记录到可显示的内容。</p>
        ) : (
          <ol aria-label="对话内容" className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
            {transcript.entries.map((entry, index) => (
              <Entry key={`${entry.at ?? ""}-${index}`} entry={entry} />
            ))}
            {transcript.truncated && <li className="text-center text-2xs text-muted">内容过长，已截断</li>}
          </ol>
        )}
      </Card>
    </div>
  );
}
