import { useMemo } from "react";
import type { ApprovalRequest, ProjectScope, RunState } from "../types";
import { useRunQueries } from "./run-events/queries";
import { useProjectStream, useRunStream } from "./run-events/streams";
import type { StreamHost } from "./run-events/streams";

interface UseRunEventsOptions {
  /** 证据面板可见（桌面 tab 或移动端视图）时才随 run 更新拉取证据 */
  evidenceVisible: boolean;
  /** 用量面板可见时才拉取用量报告 */
  usageVisible: boolean;
}

/**
 * 运行监控数据与事件流：查询与状态在 `useRunQueries`，两条 SSE 订阅在
 * `run-events/streams`。这里只负责把它们接起来。
 */
export function useRunEvents(
  scope: ProjectScope | undefined,
  options: UseRunEventsOptions,
) {
  const queries = useRunQueries(scope, options);
  const host = useMemo<StreamHost>(
    () => ({
      setConnected: queries.setConnected,
      setEvents: queries.setEvents,
      setError: queries.setError,
      scheduleRefresh: queries.scheduleRefresh,
      refreshRuns: queries.refreshRuns,
    }),
    [
      queries.refreshRuns,
      queries.scheduleRefresh,
      queries.setConnected,
      queries.setError,
      queries.setEvents,
    ],
  );

  useRunStream(scope, queries.selectedRunId, host);
  useProjectStream(scope, queries.refreshRuns);

  return queries;
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
