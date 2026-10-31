import { describe, expect, it } from "vitest";
import {
  channelKey,
  holdReason,
  markDropped,
  markFailed,
  markSent,
  messageId,
  pending,
  planDelivery,
  receiptFor,
  type EnqueueInput,
  type OutboxMessage,
} from "../src/authority/outbox.js";

const channel = { sourceKind: "github", sourceInstanceId: "acme/demo", threadId: "pull/7" };

const input = (patch: Partial<EnqueueInput> = {}): EnqueueInput => ({
  purpose: "acknowledgement",
  subjectId: "tk1",
  channel,
  body: "on it",
  at: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const queued = (patch: Partial<OutboxMessage> = {}): OutboxMessage => ({
  ...receiptFor(input()),
  ...patch,
});

describe("identity", () => {
  it("keys a message by purpose, subject and channel", () => {
    expect(messageId(input())).toBe(`acknowledgement\u0000tk1\u0000${channelKey(channel)}`);
  });

  it("treats a second acknowledgement of the same thing as the same message", () => {
    const first = receiptFor(input());
    const again = receiptFor(input({ body: "different words" }), first);
    expect(again).toBe(first);
    expect(again.body).toBe("on it");
  });

  it("keeps a different purpose apart from the same subject", () => {
    expect(messageId(input({ purpose: "result" }))).not.toBe(messageId(input()));
  });

  it("keeps a different Thread apart", () => {
    expect(messageId(input({ channel: { ...channel, threadId: "pull/8" } }))).not.toBe(
      messageId(input()),
    );
  });
});

describe("receipts", () => {
  it("starts queued with no attempts", () => {
    expect(receiptFor(input())).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("records a successful send with its time", () => {
    const sent = markSent(queued(), "2026-01-01T01:00:00.000Z");
    expect(sent).toMatchObject({ state: "sent", attempts: 1, sentAt: "2026-01-01T01:00:00.000Z" });
  });

  it("keeps the reason of a failure so the next attempt knows it", () => {
    const failed = markFailed(queued(), "2026-01-01T01:00:00.000Z", "rate limited");
    expect(failed).toMatchObject({ state: "failed", attempts: 1 });
    expect(failed.lastError).toContain("rate limited");
    const retried = markFailed(failed, "2026-01-01T02:00:00.000Z", "still limited");
    expect(retried.attempts).toBe(2);
    expect(retried.lastError).toContain("still limited");
  });

  it("records a dropped message as dropped, never as sent", () => {
    expect(markDropped(queued())).toMatchObject({ state: "dropped" });
  });
});

describe("delivery", () => {
  const ready = { sourceEnabled: true, conversationGone: false };

  it("sends a queued message to an available source", () => {
    expect(planDelivery(queued(), ready)).toMatchObject({ action: "send" });
    expect(holdReason(queued(), ready)).toBeUndefined();
  });

  it("waits while the source is off, rather than dropping or sending", () => {
    const plan = planDelivery(queued(), { sourceEnabled: false, conversationGone: false });
    expect(plan).toMatchObject({ action: "wait", reason: "source-off" });
  });

  it("drops a message whose conversation is gone", () => {
    expect(planDelivery(queued(), { sourceEnabled: true, conversationGone: true })).toMatchObject({
      action: "drop",
      reason: "conversation-gone",
    });
  });

  it("never sends the same message twice", () => {
    const sent = markSent(queued(), "t");
    expect(planDelivery(sent, ready)).toMatchObject({ action: "skip" });
  });

  it("does not resurrect a dropped message", () => {
    expect(planDelivery(markDropped(queued()), ready)).toMatchObject({ action: "drop" });
  });

  it("retries a failed message", () => {
    const failed = markFailed(queued(), "t", "boom");
    expect(planDelivery(failed, ready)).toMatchObject({ action: "send" });
  });
});

describe("pending", () => {
  it("lists what is still worth trying, oldest first", () => {
    const newer = queued({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" });
    const older = queued({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const sent = markSent(queued({ id: "c", createdAt: "2025-12-31T00:00:00.000Z" }), "t");
    expect(pending([newer, older, sent]).map((message) => message.id)).toEqual(["a", "b"]);
  });

  it("keeps failed messages in the queue", () => {
    expect(pending([markFailed(queued(), "t", "boom")])).toHaveLength(1);
  });

  it("drops neither sent nor dropped messages from the list", () => {
    expect(pending([markDropped(queued())])).toEqual([]);
  });
});
