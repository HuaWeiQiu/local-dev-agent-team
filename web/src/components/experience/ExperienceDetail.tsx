import { ArchiveX, BookMarked, CheckCircle2, Eye, Share2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import {
  formatExperienceCondition,
  formatExperienceTag,
  formatTimestamp,
  shortRunId,
} from "../../presentation";
import type { ExperienceEntry } from "../../types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, SectionTitle } from "../../ui/card";
import { Callout } from "../../ui/form";
import { scopeLabel, statusLabels, statusTone } from "./model";

interface ExperienceDetailProps {
  entry: ExperienceEntry;
  busy: boolean;
  onPromote(): void;
  onReject(): void;
  onShare(): void;
  onRetire(): void;
}

export function ExperienceDetail({ entry, busy, onPromote, onReject, onShare, onRetire }: ExperienceDetailProps) {
  const canPromote = entry.scope === "project" && entry.status === "candidate";
  const canShare =
    entry.scope === "project" &&
    entry.status === "verified" &&
    entry.sensitivity === "low" &&
    entry.portability === "cross-project";
  const canReject = entry.status === "candidate" || entry.status === "verified";
  const canRetire = entry.status === "verified";
  const readOnly = !canPromote && !canShare && !canReject && !canRetire;
  const conditions = entry.conditions.slice(0, 5).map(formatExperienceCondition);
  const tags = entry.tags.slice(0, 6).map(formatExperienceTag);

  return (
    <article className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={statusTone[entry.status]}>{statusLabels[entry.status]}</Badge>
          <Badge>{scopeLabel(entry.scope)}</Badge>
          <Badge>{entry.portability === "cross-project" ? "可跨项目" : "仅本项目"}</Badge>
        </div>
        <h2 title={entry.summary} className="m-0 break-words text-lg font-semibold leading-snug tracking-tight text-ink">
          {entry.summary}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {canPromote && (
            <Button variant="primary" disabled={busy} onClick={onPromote}>
              <CheckCircle2 />
              晋升
            </Button>
          )}
          {canShare && (
            <Button disabled={busy} onClick={onShare}>
              <Share2 />
              共享
            </Button>
          )}
          {canRetire && (
            <Button disabled={busy} onClick={onRetire}>
              <ArchiveX />
              退役
            </Button>
          )}
          {canReject && (
            <Button variant="danger" disabled={busy} onClick={onReject}>
              <XCircle />
              拒绝
            </Button>
          )}
          {readOnly && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Eye aria-hidden className="size-3.5" />
              只读
            </span>
          )}
        </div>
      </header>

      {entry.failureReason ? <Callout tone="danger">拒绝：{entry.failureReason}</Callout> : null}

      <Card className="flex flex-col gap-3 p-4">
        <SectionTitle>条件</SectionTitle>
        {conditions.length === 0 ? (
          <p className="m-0 text-xs text-muted">无</p>
        ) : (
          <ChipList items={conditions} />
        )}
      </Card>

      {tags.length > 0 && (
        <Card className="flex flex-col gap-3 p-4">
          <SectionTitle>标签</SectionTitle>
          <ChipList items={tags} />
        </Card>
      )}

      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
        <Meta label="来源">
          <code title={entry.sourceRunId} className="font-mono text-xs text-ink-2">
            {shortRunId(entry.sourceRunId)}
          </code>
        </Meta>
        <Meta label="命中">
          <span className="tabular-nums">{entry.hitCount}</span>
        </Meta>
        <Meta label="更新">{formatTimestamp(entry.updatedAt)}</Meta>
      </dl>
    </article>
  );
}

export function ExperienceEmpty() {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span aria-hidden className="grid size-11 place-items-center rounded-full bg-surface-3 text-muted">
        <BookMarked className="size-5" />
      </span>
      <strong className="text-sm font-medium text-ink">选一条经验</strong>
      <span className="text-xs text-muted">晋升 / 共享 / 拒绝</span>
    </div>
  );
}

function ChipList({ items }: { items: string[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {items.map((item) => (
        <li key={item} className="bd break-words rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-2">
          {item}
        </li>
      ))}
    </ul>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink-2">{children}</dd>
    </div>
  );
}
