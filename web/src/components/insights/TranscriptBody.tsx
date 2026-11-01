import { Badge } from "../../ui/badge";
import { cn } from "../../ui/cn";
import type { Transcript, TranscriptEntry } from "../../types";
import { entryStyles } from "./entry-style";

/** The status chip; a completed status says nothing the row does not already say. */
function StatusBadge({ status }: { status: string | undefined }) {
  if (!status || status === "completed") return null;
  return <Badge tone={status === "failed" ? "danger" : "info"}>{status}</Badge>;
}

/** The label and status chips above the text. A plain message carries neither. */
function EntryBadges({ entry, labelTone }: { entry: TranscriptEntry; labelTone: "active" | "neutral" }) {
  if (!entry.label && !entry.status) return null;
  return (
    <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
      {entry.label && <Badge tone={labelTone}>{entry.label}</Badge>}
      <StatusBadge status={entry.status} />
    </div>
  );
}

/** One row of the conversation: a turn marker, or an icon plus the text it carries. */
function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "turn") return <li className="text-center text-2xs text-muted">{entry.text}</li>;
  const style = entryStyles[entry.kind];
  const Icon = style.icon;
  return (
    <li className="flex gap-2.5">
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", style.iconClass)} />
      <div className="min-w-0 flex-1">
        <EntryBadges entry={entry} labelTone={style.labelTone} />
        <pre
          className={cn(
            "m-0 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-ink-2",
            style.bodyClass,
          )}
        >
          {entry.text}
        </pre>
      </div>
    </li>
  );
}

function EntryList({ transcript }: { transcript: Transcript }) {
  return (
    <ol aria-label="对话内容" className="m-0 mt-3 flex list-none flex-col gap-3 p-0">
      {transcript.entries.map((entry, index) => (
        <Entry key={`${entry.at ?? ""}-${index}`} entry={entry} />
      ))}
      {transcript.truncated && <li className="text-center text-2xs text-muted">内容过长，已截断</li>}
    </ol>
  );
}

/** Error, then loading, then "nothing recorded", then the entries themselves. */
export function TranscriptBody({ transcript, error }: { transcript: Transcript | undefined; error: string | undefined }) {
  if (error) {
    return (
      <p role="alert" className="m-0 mt-2 text-xs text-danger-ink">
        {error}
      </p>
    );
  }
  if (!transcript) {
    return (
      <p role="status" className="m-0 mt-2 text-xs text-muted">
        正在读取…
      </p>
    );
  }
  if (transcript.entries.length === 0) {
    return <p className="m-0 mt-2 text-xs text-muted">这次调用没有记录到可显示的内容。</p>;
  }
  return <EntryList transcript={transcript} />;
}
