// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketAttention } from "../web/src/attention.js";
import type { WorkspaceViewProps } from "../web/src/app/WorkspaceView.js";
import type { ProjectScope, PublicConfig, RunSummary } from "../web/src/types.js";

// Only the ticket read is replaced; the rest of the module (ApiError and the
// other clients) is the real one, because the shell imports it too.
vi.mock("../web/src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web/src/api.js")>();
  return { ...actual, getTicketAttention: vi.fn() };
});

const { WorkspaceView } = await import("../web/src/app/WorkspaceView.js");

const scope: ProjectScope = { mode: "single", projectId: "p1" };

function config(): PublicConfig {
  return {
    project: { name: "demo", maxParallel: 2 },
    roles: {},
    strategies: { default: "balanced", definitions: { balanced: {} } },
  } as unknown as PublicConfig;
}

function run(): RunSummary {
  return {
    id: "run-1",
    goal: "给购物车加优惠券",
    status: "implementing",
    strategy: "balanced",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    taskCounts: { total: 4, done: 1 },
  } as unknown as RunSummary;
}

/** The board workspace as the shell mounts it: monitor mode, board view, one run. */
function shellProps(): WorkspaceViewProps {
  return {
    mode: "monitor",
    monitorView: "board",
    config: config(),
    scope,
    scopeKey: "single:p1",
    projectName: "demo",
    monitor: { runs: [run()] } as never,
    busy: false,
    monitorPanel: "overview",
    demo: false,
    actions: {} as never,
    onNavigate: vi.fn(),
    onSaved: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenGlobal: vi.fn(),
    onSelectRun: vi.fn(),
    onCreate: vi.fn(),
    onOpenCleanup: vi.fn(),
    onDeleteRun: vi.fn(),
    onLaunch: vi.fn(),
    onMonitorPanelChange: vi.fn(),
    onReviewApproval: vi.fn(),
    onSelectTask: vi.fn(),
    onError: vi.fn(),
  };
}

function state(patch: Partial<TicketAttention> = {}): TicketAttention {
  return { attention: [], working: 0, total: 0, ...patch };
}

async function serve(next: TicketAttention): Promise<void> {
  const api = await import("../web/src/api.js");
  (api.getTicketAttention as ReturnType<typeof vi.fn>).mockResolvedValue(next);
}

/** The panel card itself: its header holds the section title. */
function attentionCard(): HTMLElement {
  const card = screen.getByText("待处理").closest("div");
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("attention panel inside the board workspace", () => {
  it("is mounted above the board list", async () => {
    await serve(state({ working: 1, total: 1 }));
    render(<WorkspaceView {...shellProps()} />);

    await waitFor(() => expect(screen.getByText("1 项在执行中，无需处理")).toBeVisible());

    const lanes = screen.getByRole("region", { name: "执行中" });
    expect(attentionCard().compareDocumentPosition(lanes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the headline of a ticket waiting on a person", async () => {
    await serve(
      state({
        attention: [{ ticketId: "tk-1", kind: "blocked", headline: "等待你批准发布" }],
        working: 1,
        total: 2,
      }),
    );
    render(<WorkspaceView {...shellProps()} />);

    await waitFor(() => expect(screen.getByText("1 项待处理，另有 1 项在执行中")).toBeVisible());
    expect(within(attentionCard()).getByText("等待你批准发布")).toBeVisible();
  });

  it("keeps healthy work to one line and no rows", async () => {
    await serve(state({ working: 2, total: 2 }));
    render(<WorkspaceView {...shellProps()} />);

    await waitFor(() => expect(screen.getByText("2 项在执行中，无需处理")).toBeVisible());
    const panel = attentionCard();
    expect(within(panel).queryByRole("list")).toBeNull();
    expect(within(panel).queryAllByRole("listitem")).toHaveLength(0);
  });
});
