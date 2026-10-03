import { useCallback, useEffect, useRef, useState } from "react";
import {
  getRunExplanation,
  getRunReplay,
  getRunUsageBreakdown,
  getTaskDiff,
  getTranscript,
  getTranscripts,
} from "../api";
import type {
  ProjectScope,
  ReplayStep,
  RunExplanation,
  RunUsageBreakdown,
  TaskDiff,
  Transcript,
  TranscriptSummary,
} from "../types";

const REFRESH_DEBOUNCE_MS = 600;

export interface RunInsights {
  explanation: RunExplanation | undefined;
  usage: RunUsageBreakdown | undefined;
  replay: ReplayStep[] | undefined;
  transcripts: TranscriptSummary[] | undefined;
  loading: boolean;
  error: string | undefined;
  loadTranscript(id: string): Promise<Transcript>;
  loadDiff(taskId: string): Promise<TaskDiff>;
}

/**
 * Per-run read models. The one-line explanation is always fresh; the heavier
 * views load only while the insights tab is open and refresh (debounced) as
 * the run changes.
 */
export function useRunInsights(
  scope: ProjectScope | undefined,
  runId: string | undefined,
  version: string | undefined,
  detailed: boolean,
): RunInsights {
  const [explanation, setExplanation] = useState<RunExplanation>();
  const [usage, setUsage] = useState<RunUsageBreakdown>();
  const [replay, setReplay] = useState<ReplayStep[]>();
  const [transcripts, setTranscripts] = useState<TranscriptSummary[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef({ scope, runId });
  latest.current = { scope, runId };

  useEffect(() => {
    setExplanation(undefined);
    setUsage(undefined);
    setReplay(undefined);
    setTranscripts(undefined);
    setError(undefined);
  }, [runId]);

  useEffect(() => {
    if (!scope || !runId) return;
    const timer = window.setTimeout(() => {
      const stale = () => latest.current.runId !== runId;
      void (async () => {
        setLoading(detailed);
        try {
          const wanted = await Promise.all([
            getRunExplanation(scope, runId),
            detailed ? getRunUsageBreakdown(scope, runId) : undefined,
            detailed ? getRunReplay(scope, runId) : undefined,
            detailed ? getTranscripts(scope, runId) : undefined,
          ]);
          if (stale()) return;
          setExplanation(wanted[0]);
          if (wanted[1]) setUsage(wanted[1]);
          if (wanted[2]) setReplay(wanted[2]);
          if (wanted[3]) setTranscripts(wanted[3]);
          setError(undefined);
        } catch (cause) {
          if (!stale()) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (!stale()) setLoading(false);
        }
      })();
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [scope, runId, version, detailed]);

  const loadTranscript = useCallback(
    async (id: string) => {
      if (!scope || !runId) throw new Error("未选择运行");
      return await getTranscript(scope, runId, id);
    },
    [scope, runId],
  );
  const loadDiff = useCallback(
    async (taskId: string) => {
      if (!scope || !runId) throw new Error("未选择运行");
      return await getTaskDiff(scope, runId, taskId);
    },
    [scope, runId],
  );

  return { explanation, usage, replay, transcripts, loading, error, loadTranscript, loadDiff };
}
