import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { answerAgent, getRunAgents, interruptAgent, steerAgent } from "../api";
import { isLiveAgentEvent } from "../agent-feed";
import { runActionErrorMessage } from "../presentation";
import type { LiveAgent, ProjectScope, RunEvent } from "../types";

const ACTOR_KEY = "agent-team.operator";
const POLL_MS = 3_000;

export interface LiveAgentControls {
  agents: LiveAgent[];
  actor: string;
  setActor(actor: string): void;
  error: string | undefined;
  pending: boolean;
  steer(agent: LiveAgent, text: string): Promise<boolean>;
  interrupt(agent: LiveAgent, note?: string): Promise<boolean>;
  answer(agent: LiveAgent, questionId: string, answer: string): Promise<boolean>;
}

/**
 * Live agents are in-memory on the control service, so they are polled and
 * refetched whenever the ledger reports a session or intervention event.
 */
export function useLiveAgents(
  scope: ProjectScope | undefined,
  runId: string | undefined,
  events: RunEvent[],
  active: boolean,
): LiveAgentControls {
  const [agents, setAgents] = useState<LiveAgent[]>([]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [actor, setActorState] = useState(() => {
    try {
      return window.localStorage.getItem(ACTOR_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const current = useRef({ scope, runId });
  current.current = { scope, runId };

  const refresh = useCallback(async () => {
    if (!scope || !runId) return;
    try {
      const next = await getRunAgents(scope, runId);
      if (current.current.runId === runId) setAgents(next);
    } catch {
      // The next event or poll tick retries; a failed read must not disturb the page.
    }
  }, [scope, runId]);

  const signal = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (isLiveAgentEvent(event.type)) return event.sequence;
    }
    return 0;
  }, [events]);

  useEffect(() => {
    setAgents([]);
    setError(undefined);
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh, signal]);

  useEffect(() => {
    if (!active) {
      setAgents([]);
      return;
    }
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const setActor = useCallback((next: string) => {
    setActorState(next);
    try {
      window.localStorage.setItem(ACTOR_KEY, next);
    } catch {
      // Persisting the operator name is a convenience only.
    }
  }, []);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      if (!actor.trim()) {
        setError("请先填写操作者名称");
        return false;
      }
      setPending(true);
      setError(undefined);
      try {
        await action();
        await refresh();
        return true;
      } catch (requestError) {
        setError(runActionErrorMessage(requestError));
        return false;
      } finally {
        setPending(false);
      }
    },
    [actor, refresh],
  );

  return {
    agents,
    actor,
    setActor,
    error,
    pending,
    steer: (agent, text) =>
      run(async () => {
        if (scope) await steerAgent(scope, agent.runId, agent.id, { actor: actor.trim(), text });
      }),
    interrupt: (agent, note) =>
      run(async () => {
        if (scope) {
          await interruptAgent(scope, agent.runId, agent.id, {
            actor: actor.trim(),
            ...(note?.trim() ? { note: note.trim() } : {}),
          });
        }
      }),
    answer: (agent, questionId, answer) =>
      run(async () => {
        if (scope) await answerAgent(scope, agent.runId, agent.id, { actor: actor.trim(), questionId, answer });
      }),
  };
}
