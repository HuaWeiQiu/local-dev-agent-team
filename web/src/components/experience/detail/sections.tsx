import { ArchiveX, BookMarked, CheckCircle2, Eye, Share2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { formatTimestamp, shortRunId } from "../../../presentation";
import type { ExperienceEntry } from "../../../types";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Card, SectionTitle } from "../../../ui/card";
import { Callout } from "../../../ui/form";
import { scopeLabel, statusLabels, statusTone } from "../model";
import { portabilityLabel, type ExperienceActions } from "./model";

export function DetailHeader({
  entry,
  actions,
  busy,
  onPromote,
  onReject,
  onShare,
  onRetire,
}: {
  entry: ExperienceEntry;
  actions: ExperienceActions;
  busy: boolean;
  onPromote(): void;
  onReject(): void;
  onShare(): void;
  onRetire(): void;
}) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={statusTone[entry.status]}>{statusLabels[entry.status]}</Badge>
        <Badge>{scopeLabel(entry.scope)}</Badge>
        <Badge>{portabilityLabel(entry)}</Badge>
      </div>
      <h2 title={entry.summary} className="m-0 break-words text-lg font-semibold leading-snug tracking-tight text-ink">
        {entry.summary}
      </h2>
      <ActionRow
        actions={actions}
        busy={busy}
        onPromote={onPromote}
        onReject={onReject}
        onShare={onShare}
        onRetire={onRetire}
      />
    </header>
  );
}

function ActionRow({
  actions,
  busy,
  onPromote,
  onReject,
  onShare,
  onRetire,
}: {
  actions: ExperienceActions;
  busy: boolean;
  onPromote(): void;
  onReject(): void;
  onShare(): void;
  onRetire(): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.promote && (
        <Button variant="primary" disabled={busy} onClick={onPromote}>
          <CheckCircle2 />
          晋升
        </Button>
      )}
      {actions.share && (
        <Button disabled={busy} onClick={onShare}>
          <Share2 />
          共享
        </Button>
      )}
      {actions.retire && (
        <Button disabled={busy} onClick={onRetire}>
          <ArchiveX />
          退役
        </Button>
      )}
      {actions.reject && (
        <Button variant="danger" disabled={busy} onClick={onReject}>
          <XCircle />
          拒绝
        </Button>
      )}
      {actions.readOnly && <ReadOnlyHint />}
    </div>
  );
}

function ReadOnlyHint() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <Eye aria-hidden className="size-3.5" />
      只读
    </span>
  );
}

export function FailureCallout({ reason }: { reason: string }) {
  return <Callout tone="danger">拒绝：{reason}</Callout>;
}

export function ConditionsCard({ conditions }: { conditions: string[] }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SectionTitle>条件</SectionTitle>
      {conditions.length === 0 ? <p className="m-0 text-xs text-muted">无</p> : <ChipList items={conditions} />}
    </Card>
  );
}

export function TagsCard({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <SectionTitle>标签</SectionTitle>
      <ChipList items={tags} />
    </Card>
  );
}

export function MetaRow({ entry }: { entry: ExperienceEntry }) {
  return (
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
