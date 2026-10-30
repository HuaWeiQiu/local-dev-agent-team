import { useEffect, useRef } from "react";
import { eventStreamUrl } from "../../api";
import { retainAgentMonitorEvents } from "../../agent-activity";
import { acceptNewEvents } from "../../event-merge";
import type { ProjectScope, RunEvent } from "../../types";

const RUN_FLUSH_MS = 120;
const LIST_REFRESH_MS = 150;

export interface StreamHost {
  setConnected(value: boolean): void;
  setEvents(updater: (current: RunEvent[]) => RunEvent[]): void;
  setError(value: string): void;
  scheduleRefresh(runId: string): void;
  refreshRuns(): Promise<void>;
}

/** SSE subscription for the selected run: buffer, de-duplicate, then flush. */
export function useRunStream(
  scope: ProjectScope | undefined,
  selectedRunId: string | undefined,
  host: StreamHost,
): void {
  const eventBuffer = useRef<RunEvent[]>([]);
  const flushTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!scope || !selectedRunId) return;
    const source = new EventSource(eventStreamUrl(scope, selectedRunId));
    const session = createRunStreamSession(source, selectedRunId, host, eventBuffer, flushTimer);
    return () => session.close();
  }, [host, scope, selectedRunId]);
}

interface RunStreamSession {
  close(): void;
}

function createRunStreamSession(
  source: EventSource,
  runId: string,
  host: StreamHost,
  buffer: { current: RunEvent[] },
  flushTimer: { current: number | undefined },
): RunStreamSession {
  let active = true;
  let lastSequence = 0;

  const flush = (): void => {
    flushTimer.current = undefined;
    if (!active || buffer.current.length === 0) return;
    const result = acceptNewEvents(lastSequence, buffer.current);
    buffer.current = [];
    if (result.accepted.length === 0) return;
    lastSequence = result.lastSequence;
    host.setEvents((current) => retainAgentMonitorEvents([...current, ...result.accepted]));
  };

  source.onopen = () => {
    if (active) host.setConnected(true);
  };
  source.onerror = () => {
    if (active) host.setConnected(false);
  };
  source.onmessage = (message) => {
    if (!active) return;
    acceptMessage(message, { buffer, flushTimer, flush, runId, schedule: host.scheduleRefresh, fail: host.setError });
  };

  return {
    close: () => {
      active = false;
      source.close();
      host.setConnected(false);
      window.clearTimeout(flushTimer.current);
      flushTimer.current = undefined;
      buffer.current = [];
    },
  };
}

function acceptMessage(
  message: MessageEvent<string>,
  ctx: {
    buffer: { current: RunEvent[] };
    flushTimer: { current: number | undefined };
    flush(): void;
    runId: string;
    schedule(runId: string): void;
    fail(message: string): void;
  },
): void {
  try {
    const event = JSON.parse(message.data) as RunEvent;
    ctx.buffer.current.push(event);
    ctx.flushTimer.current ??= window.setTimeout(ctx.flush, RUN_FLUSH_MS);
    if (event.type === "run.updated" || event.type === "run.crashed") {
      ctx.schedule(ctx.runId);
    }
  } catch {
    ctx.fail("收到无法解析的运行事件");
  }
}

/** Project-level stream: any run event refreshes the list, throttled. */
export function useProjectStream(
  scope: ProjectScope | undefined,
  refreshRuns: () => Promise<void>,
): void {
  useEffect(() => {
    if (!scope) return;
    const source = new EventSource(eventStreamUrl(scope));
    let active = true;
    let timer: number | undefined;
    source.onmessage = () => {
      if (!active) return;
      timer ??= window.setTimeout(() => {
        timer = undefined;
        void refreshRuns().catch(() => undefined);
      }, LIST_REFRESH_MS);
    };
    return () => {
      active = false;
      source.close();
      window.clearTimeout(timer);
    };
  }, [refreshRuns, scope]);
}
