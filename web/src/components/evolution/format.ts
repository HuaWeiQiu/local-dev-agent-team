import { ApiError } from "../../api";
import { errorMessage } from "../../presentation";
import type {
  AutomaticEvolutionSnapshot,
  EvolutionAuditRecord,
  EvolutionCompletedApplication,
} from "../../types";
import type { StatusToneName } from "../../ui/status";

export const refreshRequiredEvolutionCodes = new Set([
  "STALE_PREVIEW",
  "STALE_CATALOG_REVISION",
  "TARGET_DRIFTED",
  "ACTIVE_TARGET_CONFLICT",
  "RECOVERY_REQUIRED",
]);

export function evolutionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "本地控制会话尚未建立，请从服务启动时输出的地址重新打开应用。";
    if (error.code === "ORIGIN_DENIED") return "当前页面来源与控制服务不一致，请从控制服务地址打开应用。";
    if (error.code === "ACTIVE_RUN_CONFLICT") return "项目中仍有 Agent 操作正在进行，结束后可使用同一确认重新提交。";
    if (error.code === "RECOVERY_REQUIRED") return "本地演进状态需要恢复，当前操作已安全停止。";
    if (error.code === "AUTOMATION_DISABLED") return "当前项目未启用自动演进，请先更新 agent-team.yaml。";
    if (error.code === "AUTOMATION_RUNNING") return "自动演进已经在运行，请等待完成或先停止。";
    if (error.code === "AUTOMATION_NOT_RUNNING") return "自动演进已经停止，当前没有可停止的循环。";
    if (error.code === "AUTOMATION_CYCLE_LIMIT") return "循环次数超出当前项目配置的安全上限。";
    if (error.code === "AUTOMATION_TARGET_CONFLICT") return "自动演进目标已被其他策略占用，未修改现有目标。";
    if (error.code === "AUTOMATION_BUDGET_EXPANSION") return "候选提高了资源或时间上限，已安全拒绝本轮自动应用。";
    if (error.code === "AUTOMATION_COMMAND_CONFLICT") return "这个启动请求已被其他自动演进会话使用，请刷新状态后再决定。";
    if (error.code === "PROPOSAL_ARCHIVED") return "候选已归档，请先取消归档再执行变更操作。";
    if (error.code === "PROPOSAL_ALREADY_ARCHIVED") return "候选已经归档，无需重复操作。";
    if (error.code === "PROPOSAL_NOT_ARCHIVED") return "候选不在已归档状态，无法取消归档。";
    if (error.code === "PROPOSAL_STATE_CONFLICT") return "候选当前状态不允许该操作，请刷新后核对。";
    if (error.code === "PROPOSAL_NOT_DELETABLE") return "只有已拒绝的候选可以删除。";
    if (error.code === "REASON_REQUIRED") return "该操作必须填写原因。";
  }
  return errorMessage(error);
}

export const formatDate = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export const shortDigest = (digest: string | null) =>
  digest ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : "尚未应用";

export const auditLabel = (kind: EvolutionAuditRecord["kind"]) =>
  kind === "promotion" ? "晋升审计" : kind === "rollback" ? "回滚审计" : "拒绝审计";

export const completedLabel = (operation: EvolutionCompletedApplication["operation"]) =>
  operation === "promote-and-apply" ? "应用完成" : operation === "rollback-applied" ? "回滚完成" : "登记完成";

export function evidenceItemSummary(id: string, fallback: string, passed: boolean): string {
  if (!passed) return fallback;
  if (id === "server-candidate-trust-v1") return "当前项目信任边界与受限能力检查通过；候选未执行";
  if (id === "server-strategy-preflight-v1") return "策略结构、拓扑、角色配置与目录条件检查通过；候选未执行";
  if (id === "server-prompt-object-integrity-v1") return "提示词对象摘要、大小、权限与 UTF-8 检查通过；候选未执行";
  if (id === "server-prompt-target-trust-v1") return "提示词目标路径、内容与 Git 跟踪条件检查通过；候选未执行";
  return fallback;
}

export function automationStatusLabel(status: AutomaticEvolutionSnapshot["status"]): string {
  if (status === "running") return "运行中";
  if (status === "stopping") return "停止中";
  if (status === "completed") return "已完成";
  if (status === "stopped") return "已停止";
  if (status === "paused") return "已暂停（基础设施）";
  if (status === "failed") return "失败封闭";
  return "待启动";
}

export function automationTone(status: AutomaticEvolutionSnapshot["status"]): StatusToneName {
  if (status === "running" || status === "stopping") return "active";
  if (status === "completed") return "success";
  if (status === "paused") return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}

export function automationStatusText(automation: AutomaticEvolutionSnapshot): string {
  if (automation.status === "running" || automation.status === "stopping") {
    const phases: Record<AutomaticEvolutionSnapshot["phase"], string> = {
      idle: "准备中",
      baseline: "评测当前策略",
      proposing: "生成保守候选",
      evaluating: "隔离评测候选",
      deciding: "比较确定性分数",
      applying: "应用提升策略",
      stopping: "正在安全停止",
      finished: "正在收尾",
    };
    return `${phases[automation.phase]}${automation.activeRunId ? ` · ${automation.activeRunId.slice(0, 12)}` : ""}`;
  }
  return `最多 ${automation.configuredMaxCycles} 轮，连续 ${automation.maxConsecutiveNoImprovement} 轮无提升即停止`;
}

export function clampCycles(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

export function formatScoreDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
