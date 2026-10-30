import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  ApiError,
  getConfig,
  getRun,
  getRunEvidence,
  getRuns,
  getUsage,
} from "../../api";
import { runActionErrorMessage } from "../../presentation";
import type {
  ProjectScope,
  PublicConfig,
  RunEvent,
  RunEvidence,
  RunState,
  RunSummary,
  UsageReport,
} from "../../types";

export interface RunQueries {
  config: PublicConfig | undefined;
  connected: boolean;
  runs: RunSummary[];
  selectedRunId: string | undefined;
  run: RunState | undefined;
  selectedTaskId: string | undefined;
  events: RunEvent[];
  evidence: RunEvidence | undefined;
  evidenceLoading: boolean;
  usageReport: UsageReport | undefined;
  usageLoading: boolean;
  error: string | undefined;
  setSelectedRunId(value: string | undefined): void;
  setSelectedTaskId(value: string | undefined): void;
  setRun(value: RunState | undefined): void;
  setEvents: Dispatch<SetStateAction<RunEvent[]>>;
  setEvidence(value: RunEvidence | undefined): void;
  setConnected(value: boolean): void;
  setError(value: string | undefined): void;
  refreshRuns(): Promise<void>;
  refreshConfig(): Promise<PublicConfig>;
  refreshRun(runId: string): Promise<void>;
  refreshUsage(): Promise<void>;
  resetRunScope(): void;
  scheduleRefresh(runId: string): void;
}

/**
 * Queries and state for the run monitor: config, list, selected run, evidence
 * and usage. Every fetch is guarded by the scope (and run id) it was issued for,
 * so a late response from a previous project or run is dropped instead of
 * overwriting the current selection.
 */
export function useRunQueries(
  scope: ProjectScope | undefined,
  options: { evidenceVisible: boolean; usageVisible: boolean },
): RunQueries {
  const [config, setConfig] = useState<PublicConfig>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [run, setRun] = useState<RunState>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [evidence, setEvidence] = useState<RunEvidence>();
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [usageReport, setUsageReport] = useState<UsageReport>();
  const [usageLoading, setUsageLoading] = useState(false);
  const [error, setError] = useState<string>();
  const refreshTimer = useRef<number | undefined>(undefined);
  const scopeKey = scope ? `${scope.mode}:${scope.projectId}` : undefined;
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const currentRunId = useRef(selectedRunId);
  currentRunId.current = selectedRunId;

  const refreshRuns = useRefreshRuns(scope, currentScopeKey, setRuns, setSelectedRunId);
  const refreshConfig = useRefreshConfig(scope, currentScopeKey, setConfig);
  const refreshRun = useRefreshRun(
    scope,
    currentScopeKey,
    currentRunId,
    { setRun, setSelectedTaskId, setEvents, setSelectedRunId, setError },
    refreshRuns,
  );
  const refreshEvidence = useRefreshEvidence(scope, currentScopeKey, setEvidence, setEvidenceLoading);
  const refreshUsage = useRefreshUsage(scope, currentScopeKey, setUsageReport, setUsageLoading);
  const scheduleRefresh = useScheduleRefresh(refreshTimer, refreshRuns, refreshRun);
  const resetRunScope = useResetRunScope(refreshTimer, {
    setConfig,
    setRuns,
    setSelectedRunId,
    setRun,
    setSelectedTaskId,
    setEvents,
    setEvidence,
    setUsageReport,
    setUsageLoading,
    setConnected,
    setError,
  });

  useEffect(() => {
    const timer = refreshTimer;
    return () => window.clearTimeout(timer.current);
  }, []);

  useInitialLoad(scope, resetRunScope, { setConfig, setRuns, setSelectedRunId, setError });
  useSelectedRunLoad(scope, selectedRunId, refreshRun, {
    setRun,
    setSelectedTaskId,
    setEvents,
    setEvidence,
    setError,
  });
  useEvidenceEffect(scope, selectedRunId, options.evidenceVisible, refreshEvidence, run?.updatedAt, setError);
  useUsageEffect(scope, options.usageVisible, refreshUsage, setError);

  return {
    config,
    runs,
    selectedRunId,
    run,
    selectedTaskId,
    events,
    evidence,
    evidenceLoading,
    connected,
    usageReport,
    usageLoading,
    error,
    setSelectedRunId,
    setSelectedTaskId,
    setRun,
    setEvents,
    setEvidence,
    setConnected,
    setError,
    refreshRuns,
    refreshConfig,
    refreshRun,
    refreshUsage,
    resetRunScope,
    scheduleRefresh,
  };
}

function useRefreshRuns(
  scope: ProjectScope | undefined,
  currentScopeKey: { current: string | undefined },
  setRuns: (value: RunSummary[]) => void,
  setSelectedRunId: React.Dispatch<React.SetStateAction<string | undefined>>,
): () => Promise<void> {
  return useCallback(async () => {
    if (!scope) return;
    const requested = scopeRequest(scope);
    const stale = () => currentScopeKey.current !== requested;
    try {
      const nextRuns = await getRuns(scope);
      if (stale()) return;
      setRuns(nextRuns);
      setSelectedRunId((current) => keepOrFirst(nextRuns, current));
    } catch (requestError) {
      if (!stale()) throw requestError;
    }
  }, [currentScopeKey, scope, setRuns, setSelectedRunId]);
}

function useRefreshConfig(
  scope: ProjectScope | undefined,
  currentScopeKey: { current: string | undefined },
  setConfig: (value: PublicConfig) => void,
): () => Promise<PublicConfig> {
  return useCallback(async () => {
    if (!scope) throw new Error("当前项目尚未加载");
    const requested = `${scope.mode}:${scope.projectId}`;
    const nextConfig = await getConfig(scope);
    if (currentScopeKey.current !== requested) throw new Error("项目已切换，请重试");
    setConfig(nextConfig);
    return nextConfig;
  }, [currentScopeKey, scope, setConfig]);
}

interface RunRefreshHost {
  setRun(value: RunState | undefined): void;
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setEvents: React.Dispatch<React.SetStateAction<RunEvent[]>>;
  setSelectedRunId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setError(value: string | undefined): void;
  refreshRuns(): Promise<void>;
}

function useRefreshRun(
  scope: ProjectScope | undefined,
  currentScopeKey: { current: string | undefined },
  currentRunId: { current: string | undefined },
  setters: Omit<RunRefreshHost, "refreshRuns">,
  refreshRuns: () => Promise<void>,
): (runId: string) => Promise<void> {
  const { setRun, setSelectedTaskId, setEvents, setSelectedRunId, setError } = setters;
  return useCallback(
    async (runId: string) => {
      if (!scope) return;
      const isCurrent = () => isCurrentTarget(currentScopeKey, currentRunId, scope, runId);
      try {
        const nextRun = await getRun(scope, runId);
        // 切项目或切 run 后到达的陈旧响应直接丢弃
        if (!isCurrent()) return;
        applyRun(nextRun, { setRun, setSelectedTaskId });
      } catch (requestError) {
        if (!isCurrent()) return;
        if (!isMissingRun(requestError)) throw requestError;
        forgetDeletedRun({ setRun, setSelectedTaskId, setEvents, setSelectedRunId, setError }, refreshRuns);
      }
    },
    [
      currentRunId,
      currentScopeKey,
      refreshRuns,
      scope,
      setError,
      setEvents,
      setRun,
      setSelectedRunId,
      setSelectedTaskId,
    ],
  );
}

function useRefreshEvidence(
  scope: ProjectScope | undefined,
  currentScopeKey: { current: string | undefined },
  setEvidence: (value: RunEvidence) => void,
  setLoading: (value: boolean) => void,
): (runId: string) => Promise<void> {
  return useCallback(
    async (runId: string) => {
      if (!scope) return;
      const requested = `${scope.mode}:${scope.projectId}`;
      setLoading(true);
      try {
        const nextEvidence = await getRunEvidence(scope, runId);
        if (currentScopeKey.current === requested) setEvidence(nextEvidence);
      } finally {
        if (currentScopeKey.current === requested) setLoading(false);
      }
    },
    [currentScopeKey, scope, setEvidence, setLoading],
  );
}

function useRefreshUsage(
  scope: ProjectScope | undefined,
  currentScopeKey: { current: string | undefined },
  setUsageReport: (value: UsageReport) => void,
  setLoading: (value: boolean) => void,
): () => Promise<void> {
  return useCallback(async () => {
    if (!scope) return;
    const requested = `${scope.mode}:${scope.projectId}`;
    setLoading(true);
    try {
      const nextUsage = await getUsage(scope);
      if (currentScopeKey.current === requested) setUsageReport(nextUsage);
    } finally {
      if (currentScopeKey.current === requested) setLoading(false);
    }
  }, [currentScopeKey, scope, setUsageReport, setLoading]);
}

function useScheduleRefresh(
  refreshTimer: { current: number | undefined },
  refreshRuns: () => Promise<void>,
  refreshRun: (runId: string) => Promise<void>,
): (runId: string) => void {
  return useCallback(
    (runId: string) => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        // SSE 触发的后台刷新：瞬时失败不弹全局 toast，下一轮事件会再触发
        void Promise.all([refreshRuns(), refreshRun(runId)]).catch(() => undefined);
      }, 80);
    },
    [refreshRun, refreshRuns, refreshTimer],
  );
}

interface ResetHost {
  setConfig(value: PublicConfig | undefined): void;
  setRuns(value: RunSummary[]): void;
  setSelectedRunId(value: string | undefined): void;
  setRun(value: RunState | undefined): void;
  setSelectedTaskId(value: string | undefined): void;
  setEvents(value: RunEvent[]): void;
  setEvidence(value: RunEvidence | undefined): void;
  setUsageReport(value: UsageReport | undefined): void;
  setUsageLoading(value: boolean): void;
  setConnected(value: boolean): void;
  setError(value: string | undefined): void;
}

function useResetRunScope(
  refreshTimer: { current: number | undefined },
  setters: ResetHost,
): () => void {
  const {
    setConfig,
    setRuns,
    setSelectedRunId,
    setRun,
    setSelectedTaskId,
    setEvents,
    setEvidence,
    setUsageReport,
    setUsageLoading,
    setConnected,
    setError,
  } = setters;
  return useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    setConfig(undefined);
    setRuns([]);
    setSelectedRunId(undefined);
    setRun(undefined);
    setSelectedTaskId(undefined);
    setEvents([]);
    setEvidence(undefined);
    setUsageReport(undefined);
    setUsageLoading(false);
    setConnected(false);
    setError(undefined);
  }, [
    refreshTimer,
    setConfig,
    setConnected,
    setError,
    setEvents,
    setEvidence,
    setRun,
    setRuns,
    setSelectedRunId,
    setSelectedTaskId,
    setUsageLoading,
    setUsageReport,
  ]);
}

/** A 404 means the run was cleaned up: drop it instead of showing stale data. */
function forgetDeletedRun(
  setters: Omit<RunRefreshHost, "refreshRuns">,
  refreshRuns: () => Promise<void>,
): void {
  setters.setRun(undefined);
  setters.setSelectedTaskId(undefined);
  setters.setEvents([]);
  setters.setSelectedRunId(undefined);
  setters.setError("该运行已不存在，已从当前选择中移除。");
  void refreshRuns().catch(() => undefined);
}

function useInitialLoad(
  scope: ProjectScope | undefined,
  resetRunScope: () => void,
  setters: {
    setConfig(value: PublicConfig): void;
    setRuns(value: RunSummary[]): void;
    setSelectedRunId(value: string | undefined): void;
    setError(value: string | undefined): void;
  },
): void {
  const { setConfig, setRuns, setSelectedRunId, setError } = setters;
  useEffect(() => {
    if (!scope) return;
    let active = true;
    resetRunScope();
    void Promise.all([getConfig(scope), getRuns(scope)])
      .then(([nextConfig, nextRuns]) => {
        if (!active) return;
        setConfig(nextConfig);
        setRuns(nextRuns);
        setSelectedRunId(nextRuns[0]?.id);
      })
      .catch((requestError: unknown) => {
        if (active) setError(runActionErrorMessage(requestError));
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetRunScope, scope]);
}

function useSelectedRunLoad(
  scope: ProjectScope | undefined,
  selectedRunId: string | undefined,
  refreshRun: (runId: string) => Promise<void>,
  setters: {
    setRun(value: RunState | undefined): void;
    setSelectedTaskId(value: string | undefined): void;
    setEvents(value: RunEvent[]): void;
    setEvidence(value: RunEvidence | undefined): void;
    setError(value: string | undefined): void;
  },
): void {
  const { setRun, setSelectedTaskId, setEvents, setEvidence, setError } = setters;
  useEffect(() => {
    if (!scope || !selectedRunId) {
      setRun(undefined);
      setEvents([]);
      setEvidence(undefined);
      return;
    }
    setRun(undefined);
    setSelectedTaskId(undefined);
    setEvents([]);
    setEvidence(undefined);
    void refreshRun(selectedRunId).catch((requestError: unknown) =>
      setError(runActionErrorMessage(requestError)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRun, scope, selectedRunId]);
}

function useEvidenceEffect(
  scope: ProjectScope | undefined,
  selectedRunId: string | undefined,
  evidenceVisible: boolean,
  refreshEvidence: (runId: string) => Promise<void>,
  updatedAt: string | undefined,
  setError: (value: string | undefined) => void,
): void {
  useEffect(() => {
    if (!selectedRunId || !scope || !evidenceVisible) return;
    void refreshEvidence(selectedRunId).catch((requestError: unknown) =>
      setError(runActionErrorMessage(requestError)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidenceVisible, refreshEvidence, updatedAt, scope, selectedRunId]);
}

function useUsageEffect(
  scope: ProjectScope | undefined,
  usageVisible: boolean,
  refreshUsage: () => Promise<void>,
  setError: (value: string | undefined) => void,
): void {
  useEffect(() => {
    if (!scope || !usageVisible) return;
    void refreshUsage().catch((requestError: unknown) =>
      setError(runActionErrorMessage(requestError)),
    );
  }, [refreshUsage, scope, setError, usageVisible]);
}

function scopeRequest(scope: ProjectScope): string {
  return `${scope.mode}:${scope.projectId}`;
}

/** Keep the current selection when it still exists, otherwise take the first. */
function keepOrFirst(runs: RunSummary[], current: string | undefined): string | undefined {
  const present = current !== undefined && runs.some((item) => item.id === current);
  return present ? current : runs[0]?.id;
}

function isCurrentTarget(
  currentScopeKey: { current: string | undefined },
  currentRunId: { current: string | undefined },
  scope: ProjectScope,
  runId: string,
): boolean {
  return currentScopeKey.current === scopeRequest(scope) && currentRunId.current === runId;
}

function applyRun(
  nextRun: RunState,
  setters: Pick<RunRefreshHost, "setRun" | "setSelectedTaskId">,
): void {
  setters.setRun(nextRun);
  setters.setSelectedTaskId((current) =>
    current && nextRun.tasks.some((task) => task.task.id === current) ? current : undefined,
  );
}

/** A 404 is the only answer that means "this run no longer exists". */
function isMissingRun(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
