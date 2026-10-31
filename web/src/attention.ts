/**
 * The attention panel's own logic, kept out of the component so it can be tested
 * without a DOM: what the first screen shows, and what it deliberately does not.
 */

export type AttentionKind =
  | "delivery-failed"
  | "blocked"
  | "failed"
  | "awaiting-answer"
  | "awaiting-review";

export interface AttentionEntry {
  ticketId: string;
  kind: AttentionKind;
  headline: string;
  since?: string;
}

export interface TicketAttention {
  attention: AttentionEntry[];
  working: number;
  total: number;
}

/** How each kind reads on screen; the code stays stable, the words may change. */
export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  "delivery-failed": "投递失败",
  blocked: "受阻",
  failed: "失败",
  "awaiting-answer": "待回答",
  "awaiting-review": "待评审",
};

/** A calmer tone for the kinds that only need a look, not a repair. */
export const ATTENTION_TONE: Record<AttentionKind, "danger" | "warning"> = {
  "delivery-failed": "danger",
  blocked: "danger",
  failed: "danger",
  "awaiting-answer": "warning",
  "awaiting-review": "warning",
};

/**
 * The first screen: the queue when there is one, and a single line when there is
 * not. Healthy work never becomes a row — it is a number, or it is nothing.
 */
export function firstScreen(state: TicketAttention | undefined): {
  rows: AttentionEntry[];
  summary: string;
} {
  if (!state) return { rows: [], summary: "正在读取…" };
  const { attention, working, total } = state;
  if (attention.length === 0) {
    if (total === 0) return { rows: [], summary: "还没有任何工作" };
    return {
      rows: [],
      summary: working > 0 ? `${working} 项在执行中，无需处理` : "没有待处理的事项",
    };
  }
  const more = working > 0 ? `，另有 ${working} 项在执行中` : "";
  return { rows: attention, summary: `${attention.length} 项待处理${more}` };
}

/** How long someone has been waiting, in words rather than a timestamp. */
export function waitedFor(since: string | undefined, now: number): string {
  if (!since) return "";
  const elapsed = now - Date.parse(since);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
