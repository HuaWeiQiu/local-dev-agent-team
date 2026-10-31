import { useEffect, useState } from "react";
import { getTicketAttention } from "../api";
import {
  ATTENTION_LABEL,
  ATTENTION_TONE,
  firstScreen,
  waitedFor,
  type TicketAttention,
} from "../attention";
import type { ProjectScope } from "../types";
import { Card, SectionTitle } from "../ui/card";
import { Callout } from "../ui/form";

/**
 * The first screen: what needs a person. Healthy work is a number in the summary
 * and never a row — a list that shows healthy work costs attention without
 * giving any back.
 */
export function AttentionPanel({ scope }: { scope: ProjectScope | undefined }) {
  const [state, setState] = useState<TicketAttention>();
  const [error, setError] = useState<string>();

  const scopeKey = scope ? `${scope.mode}:${scope.projectId}` : "";
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    getTicketAttention(scope)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        // The panel is an aid: a server that cannot answer leaves it empty.
        if (!cancelled) setError("无法读取待处理事项");
      });
    return () => {
      cancelled = true;
    };
    // The scope object is a new reference on every render; the key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const screen = firstScreen(state);

  return (
    <Card className="min-w-0">
      <header className="bd-b flex items-center justify-between gap-3 px-4 py-3">
        <SectionTitle>待处理</SectionTitle>
        <span className="shrink-0 text-xs text-muted">{screen.summary}</span>
      </header>
      {error ? (
        <div className="px-4 py-3">
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        </div>
      ) : null}
      {screen.rows.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {screen.rows.map((entry) => (
            <li key={entry.ticketId} className="bd-b flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0">
                <strong className="block truncate text-sm font-medium text-ink">{entry.headline}</strong>
                <small className="block truncate text-2xs text-muted">{entry.ticketId}</small>
              </span>
              <span className={toneClass(entry.kind)}>
                {ATTENTION_LABEL[entry.kind]}
                {waitedFor(entry.since, Date.now()) ? ` · ${waitedFor(entry.since, Date.now())}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function toneClass(kind: keyof typeof ATTENTION_TONE): string {
  return ATTENTION_TONE[kind] === "danger"
    ? "shrink-0 text-xs font-medium text-danger-ink"
    : "shrink-0 text-xs font-medium text-warning-ink";
}
