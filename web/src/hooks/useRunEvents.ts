import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  eventStreamUrl,
  getConfig,
  getRun,
  getRunEvidence,
  getRuns,
  getUsage,
} from "../api";
import { retainAgentMonitorEvents } from "../agent-activity";
import { runActionErrorMessage } from "../presentation";
import type {
  ApprovalRequest,
  ProjectScope,
  PublicConfig,
  RunEvent,
  RunEvidence,
  RunState,
  RunSummary,
  UsageReport,
} from "../types";

interface UseRunEventsOptions {
  /** 证据面板可见（桌面 tab 或移动端视图）时才随 run 更新拉取证据 */
  evidenceVisible: boolean;
  /** 用量面板可见时才拉取用量报告 */
  usageVisible: boolean;
}

/**
 * 运行监控数据与事件流：项目级 + 选中 run 级 SSE 订阅、事件缓冲 flush 去重，
 * 以及列表/详情/证据/用量的刷新触发。竞态防护（scope+runId guard、active 标记）
 * 与刷新时序自 App.tsx 原样搬移。
 */
export function useRunEvents(scope: ProjectScope | undefined, { evidenceVisible, usageVisible }: UseRunEventsOptions) {
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
  const eventBuffer = useRef<RunEvent[]>([]);
  const eventFlushTimer = useRef<number | undefined>(undefined);
  const scopeKey = scope ? `${scope.mode}:${scope.projectId}` : undefined;
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const currentRunId = useRef(selectedRunId);
  currentRunId.current = selectedRunId;

  const refreshRuns = useCallback(async () => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    try {
      const nextRuns = await getRuns(scope);
      if (currentScopeKey.current !== requestedScope) return;
      setRuns(nextRuns);
      setSelectedRunId((current) => current && nextRuns.some((item) => item.id === current) ? current : nextRuns[0]?.id);
    } catch (requestError) {
      if (currentScopeKey.current === requestedScope) throw requestError;
    }
  }, [scope]);

  const refreshConfig = useCallback(async (): Promise<PublicConfig> => {
    if (!scope) throw new Error("当前项目尚未加载");
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    const nextConfig = await getConfig(scope);
    if (currentScopeKey.current !== requestedScope) {
      throw new Error("项目已切换，请重试");
    }
    setConfig(nextConfig);
    return nextConfig;
  }, [scope]);

  const refreshRun = useCallback(async (runId: string) => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    const isCurrent = () => currentScopeKey.current === requestedScope && currentRunId.current === runId;
    try {
      const nextRun = await getRun(scope, runId);
      // 切项目或切 run 后到达的陈旧响应直接丢弃，避免覆盖新选中的数据
      if (!isCurrent()) return;
      setRun(nextRun);
      setSelectedTaskId((current) => current && nextRun.tasks.some((task) => task.task.id === current) ? current : undefined);
    } catch (requestError) {
      if (!isCurrent()) return;
      if (requestError instanceof ApiError && requestError.status === 404) {
        // 运行已被删除/清理：清空选择并提示，而不是滞留旧数据
        setRun(undefined);
        setSelectedTaskId(undefined);
        setEvents([]);
        setSelectedRunId(undefined);
        setError("该运行已不存在，已从当前选择中移除。");
        void refreshRuns().catch(() => undefined);
        return;
      }
      throw requestError;
    }
  }, [refreshRuns, scope]);

  const refreshEvidence = useCallback(async (runId: string) => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    setEvidenceLoading(true);
    try {
      const nextEvidence = await getRunEvidence(scope, runId);
      if (currentScopeKey.current === requestedScope) setEvidence(nextEvidence);
    } finally {
      if (currentScopeKey.current === requestedScope) setEvidenceLoading(false);
    }
  }, [scope]);

  const refreshUsage = useCallback(async () => {
    if (!scope) return;
    const requestedScope = `${scope.mode}:${scope.projectId}`;
    setUsageLoading(true);
    try {
      const nextUsage = await getUsage(scope);
      if (currentScopeKey.current === requestedScope) setUsageReport(nextUsage);
    } finally {
      if (currentScopeKey.current === requestedScope) setUsageLoading(false);
    }
  }, [scope]);

  const scheduleRefresh = useCallback((runId: string) => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      // SSE 触发的后台刷新：瞬时失败不弹全局 toast，下一轮事件会再触发
      void Promise.all([refreshRuns(), refreshRun(runId)]).catch(() => undefined);
    }, 80);
  }, [refreshRun, refreshRuns]);

  const resetRunScope = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    eventBuffer.current = [];
    window.clearTimeout(eventFlushTimer.current);
    eventFlushTimer.current = undefined;
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
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(refreshTimer.current);
  }, []);

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
  }, [resetRunScope, scope]);

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
    void refreshRun(selectedRunId).catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));

    const source = new EventSource(eventStreamUrl(scope, selectedRunId));
    let active = true;
    let lastSequence = 0;
    source.onopen = () => {
      if (active) setConnected(true);
    };
    source.onerror = () => {
      if (active) setConnected(false);
    };
    // SSE 事件先进 ref 缓冲，~120ms 定时 flush，避免每条事件都触发全树重渲染
    const flushEvents = () => {
      eventFlushTimer.current = undefined;
      if (!active || eventBuffer.current.length === 0) return;
      // 按 sequence 去重兜底：重连续传/重放可能带重复事件，保留原有顺序
      const pending = eventBuffer.current.filter((event) => event.sequence > lastSequence);
      eventBuffer.current = [];
      if (pending.length === 0) return;
      lastSequence = pending.reduce((max, event) => Math.max(max, event.sequence), lastSequence);
      setEvents((current) => retainAgentMonitorEvents([...current, ...pending]));
    };
    source.onmessage = (message) => {
      if (!active) return;
      try {
        const event = JSON.parse(message.data) as RunEvent;
        eventBuffer.current.push(event);
        eventFlushTimer.current ??= window.setTimeout(flushEvents, 120);
        if (event.type === "run.updated" || event.type === "run.crashed") {
          scheduleRefresh(selectedRunId);
        }
      } catch {
        setError("收到无法解析的运行事件");
      }
    };
    return () => {
      active = false;
      source.close();
      setConnected(false);
      window.clearTimeout(eventFlushTimer.current);
      eventFlushTimer.current = undefined;
      eventBuffer.current = [];
    };
  }, [refreshRun, scheduleRefresh, scope, selectedRunId]);

  // 项目级事件流：任何 run（含未选中的）有事件都触发运行列表刷新
  useEffect(() => {
    if (!scope) return;
    const source = new EventSource(eventStreamUrl(scope));
    let active = true;
    let listTimer: number | undefined;
    source.onmessage = () => {
      if (!active) return;
      listTimer ??= window.setTimeout(() => {
        listTimer = undefined;
        // 后台刷新失败不打扰用户，下一条事件会再次触发
        void refreshRuns().catch(() => undefined);
      }, 150);
    };
    return () => {
      active = false;
      source.close();
      window.clearTimeout(listTimer);
    };
  }, [refreshRuns, scope]);

  useEffect(() => {
    if (!selectedRunId || !scope || !evidenceVisible) return;
    void refreshEvidence(selectedRunId).catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));
  }, [evidenceVisible, refreshEvidence, run?.updatedAt, scope, selectedRunId]);

  useEffect(() => {
    if (!scope || !usageVisible) return;
    void refreshUsage().catch((requestError: unknown) => setError(runActionErrorMessage(requestError)));
  }, [usageVisible, refreshUsage, scope]);

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
    setError,
    refreshRuns,
    refreshConfig,
    refreshRun,
    refreshUsage,
    resetRunScope,
  };
}

/** useRunEvents 的返回值集合，供 useRunActions / RunDashboard 整体消费。 */
export type RunMonitor = ReturnType<typeof useRunEvents>;

/** 顶栏审批入口：取最新一条待处理审批（纯函数，自 App.tsx 原样搬移）。 */
export function latestPendingApproval(run: RunState | undefined): ApprovalRequest | undefined {
  for (let index = (run?.approvals?.length ?? 0) - 1; index >= 0; index -= 1) {
    const approval = run?.approvals?.[index];
    if (approval?.status === "pending") return approval;
  }
  return undefined;
}
