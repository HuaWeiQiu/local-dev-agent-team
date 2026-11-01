import { useEffect, useState } from "react";
import type { Transcript, TranscriptSummary } from "../../types";

/** Whether the selection still names a transcript that is on screen. */
function stillListed(items: TranscriptSummary[], selected: string | undefined): boolean {
  return Boolean(selected) && items.some((item) => item.id === selected);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface TranscriptSelection {
  selected: string | undefined;
  select(id: string): void;
}

/** Keeps one transcript of the list selected, even after the list changes underneath it. */
export function useTranscriptSelection(items: TranscriptSummary[]): TranscriptSelection {
  const [selected, setSelected] = useState<string | undefined>(items[0]?.id);

  useEffect(() => {
    if (!stillListed(items, selected)) setSelected(items[0]?.id);
  }, [items, selected]);

  return { selected, select: setSelected };
}

export interface TranscriptContent {
  transcript: Transcript | undefined;
  error: string | undefined;
}

/** Reads the selected transcript, ignoring an answer that arrives after the selection moved on. */
export function useTranscriptContent(
  selected: string | undefined,
  onLoad: (id: string) => Promise<Transcript>,
): TranscriptContent {
  const [transcript, setTranscript] = useState<Transcript>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!selected) {
      setTranscript(undefined);
      return;
    }
    let current = true;
    setError(undefined);
    onLoad(selected).then(
      (value) => current && setTranscript(value),
      (cause: unknown) => current && setError(errorMessage(cause)),
    );
    return () => {
      current = false;
    };
  }, [selected, onLoad]);

  return { transcript, error };
}
