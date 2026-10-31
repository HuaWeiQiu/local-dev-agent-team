// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionPanel } from "../web/src/components/AttentionPanel.js";
import { ATTENTION_LABEL, firstScreen, waitedFor, type TicketAttention } from "../web/src/attention.js";

vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return { ...actual, getTicketAttention: vi.fn() };
});

const scope = { mode: "single", projectId: "p1" } as never;

function state(patch: Partial<TicketAttention> = {}): TicketAttention {
  return { attention: [], working: 0, total: 0, ...patch };
}

describe("firstScreen", () => {
  it("says it is reading before the answer arrives", () => {
    expect(firstScreen(undefined)).toEqual({ rows: [], summary: "正在读取…" });
  });

  it("says there is nothing yet when there is no work", () => {
    expect(firstScreen(state()).summary).toBe("还没有任何工作");
  });

  it("counts work in progress without listing it", () => {
    const screen = firstScreen(state({ working: 3, total: 3 }));
    expect(screen.rows).toEqual([]);
    expect(screen.summary).toBe("3 项在执行中，无需处理");
  });

  it("lists what needs a person and keeps the rest as a number", () => {
    const screen = firstScreen(
      state({
        attention: [{ ticketId: "tk1", kind: "blocked", headline: "Blocked, waiting on a person" }],
        working: 2,
        total: 3,
      }),
    );
    expect(screen.rows).toHaveLength(1);
    expect(screen.summary).toBe("1 项待处理，另有 2 项在执行中");
  });
});

describe("waitedFor", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("reads a wait in words", () => {
    expect(waitedFor(undefined, now)).toBe("");
    expect(waitedFor("not a date", now)).toBe("");
    expect(waitedFor("2026-01-01T11:59:30Z", now)).toBe("刚刚");
    expect(waitedFor("2026-01-01T11:30:00Z", now)).toBe("30 分钟");
    expect(waitedFor("2026-01-01T09:00:00Z", now)).toBe("3 小时");
    expect(waitedFor("2025-12-30T12:00:00Z", now)).toBe("2 天");
  });
});

describe("AttentionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the queue with its kind and how long it waited", async () => {
    const api = await import("../web/src/api.js");
    (api.getTicketAttention as ReturnType<typeof vi.fn>).mockResolvedValue(
      state({
        attention: [
          { ticketId: "tk1", kind: "blocked", headline: "Blocked, waiting on a person", since: "2026-01-01T11:00:00Z" },
          { ticketId: "tk2", kind: "awaiting-review", headline: "Awaiting review" },
        ],
        working: 1,
        total: 3,
      }),
    );
    render(<AttentionPanel scope={scope} />);
    await waitFor(() => expect(screen.getByText("2 项待处理，另有 1 项在执行中")).toBeVisible());
    expect(screen.getByText("Blocked, waiting on a person")).toBeVisible();
    expect(screen.getByText(ATTENTION_LABEL.blocked, { exact: false })).toBeVisible();
    expect(screen.getByText("Awaiting review")).toBeVisible();
  });

  it("shows a quiet line when nothing needs a person", async () => {
    const api = await import("../web/src/api.js");
    (api.getTicketAttention as ReturnType<typeof vi.fn>).mockResolvedValue(state({ working: 2, total: 2 }));
    render(<AttentionPanel scope={scope} />);
    await waitFor(() => expect(screen.getByText("2 项在执行中，无需处理")).toBeVisible());
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("stays quiet when the server cannot answer", async () => {
    const api = await import("../web/src/api.js");
    (api.getTicketAttention as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    render(<AttentionPanel scope={scope} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
  });
});
