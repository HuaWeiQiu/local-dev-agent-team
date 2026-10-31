/**
 * The outbox: every message this agent sends, with a receipt.
 *
 * A message is written down before it is sent, not after. That order is the point:
 * if the process dies between deciding to speak and speaking, the receipt says so,
 * and the next attempt knows what it already tried. Sending first and recording
 * afterwards loses that evidence exactly when it matters.
 *
 * The receipt is also the idempotence key. An acknowledgement, an answer, a result
 * or an attention message belongs to one thing on one Thread; asking to send it
 * twice returns the first receipt instead of speaking twice.
 */

export type MessagePurpose = "acknowledgement" | "answer" | "result" | "attention";

export type DeliveryState = "queued" | "sent" | "failed" | "dropped";

export interface OutboxChannel {
  sourceKind: string;
  sourceInstanceId: string;
  threadId: string;
}

export interface OutboxMessage {
  /** The idempotence key: purpose, channel and subject, in that order. */
  id: string;
  purpose: MessagePurpose;
  /** What this message is about: a Ticket id, an Approval id, a Decision id. */
  subjectId: string;
  channel: OutboxChannel;
  body: string;
  createdAt: string;
  state: DeliveryState;
  attempts: number;
  sentAt?: string;
  lastError?: string;
}

export interface EnqueueInput {
  purpose: MessagePurpose;
  subjectId: string;
  channel: OutboxChannel;
  body: string;
  at: string;
}

/** Why a message may not be sent right now. */
export type HoldReason = "source-off" | "conversation-gone" | "already-sent";

export function messageId(input: {
  purpose: MessagePurpose;
  subjectId: string;
  channel: OutboxChannel;
}): string {
  return [input.purpose, input.subjectId, channelKey(input.channel)].join("\u0000");
}

export function channelKey(channel: OutboxChannel): string {
  return [channel.sourceKind, channel.sourceInstanceId, channel.threadId].join("\u0000");
}

/**
 * The receipt for a message about to be sent. Enqueuing the same purpose for the
 * same subject on the same channel again is the same receipt, not a new message.
 */
export function receiptFor(input: EnqueueInput, existing?: OutboxMessage): OutboxMessage {
  const id = messageId(input);
  if (existing) return existing;
  return {
    id,
    purpose: input.purpose,
    subjectId: input.subjectId,
    channel: input.channel,
    body: input.body,
    createdAt: input.at,
    state: "queued",
    attempts: 0,
  };
}

/** A queued message that a send should pick up now, or why it should not. */
export function holdReason(
  message: OutboxMessage,
  context: { sourceEnabled: boolean; conversationGone: boolean },
): HoldReason | undefined {
  if (message.state === "sent") return "already-sent";
  if (message.state === "dropped") return "conversation-gone";
  if (!context.sourceEnabled) return "source-off";
  if (context.conversationGone) return "conversation-gone";
  return undefined;
}

/** What to do with one queued message: send it, or record why it waits. */
export type DeliveryPlan =
  | { action: "send"; message: OutboxMessage }
  | { action: "drop"; message: OutboxMessage; reason: HoldReason }
  | { action: "wait"; message: OutboxMessage; reason: HoldReason }
  | { action: "skip"; message: OutboxMessage };

export function planDelivery(
  message: OutboxMessage,
  context: { sourceEnabled: boolean; conversationGone: boolean },
): DeliveryPlan {
  const reason = holdReason(message, context);
  if (!reason) return { action: "send", message };
  if (reason === "already-sent") return { action: "skip", message };
  if (reason === "conversation-gone") return { action: "drop", message, reason };
  return { action: "wait", message, reason };
}

/** A send that worked. */
export function markSent(message: OutboxMessage, at: string): OutboxMessage {
  return { ...message, state: "sent", attempts: message.attempts + 1, sentAt: at };
}

/** A send that failed: the receipt keeps the reason so the next attempt knows. */
export function markFailed(message: OutboxMessage, at: string, error: string): OutboxMessage {
  return {
    ...message,
    state: "failed",
    attempts: message.attempts + 1,
    lastError: `${at}: ${error}`,
  };
}

/** A message whose conversation is gone is recorded as dropped, never as sent. */
export function markDropped(message: OutboxMessage): OutboxMessage {
  return { ...message, state: "dropped" };
}

/** Everything still worth trying, oldest first. */
export function pending(messages: readonly OutboxMessage[]): OutboxMessage[] {
  return messages
    .filter((message) => message.state === "queued" || message.state === "failed")
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
}
