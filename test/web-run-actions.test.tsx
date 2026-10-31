// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../web/src/ui/tooltip.js";
import { RunActions } from "../web/src/shell/RunActions.js";
import { copyText } from "../web/src/shell/actions/copy.js";
import {
  canPublish,
  canResume,
  canRetry,
  isActiveRun,
  pruneLabel,
  retryHint,
  retryLabel,
} from "../web/src/shell/actions/model.js";
import { runState } from "./support/web-fixtures.js";
import type { RunState } from "../web/src/types.js";

function run(patch: Partial<RunState> = {}): RunState {
  return { ...runState(), ...patch } as RunState;
}

function props(patch: Record<string, unknown> = {}) {
  return {
    run: run(),
    busy: false,
    pendingApproval: undefined,
    onReviewApproval: vi.fn(),
    onResume: vi.fn(),
    onPublish: vi.fn(),
    onPause: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    ...patch,
  } as never;
}

function renderActions(p: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <RunActions {...(p as object)} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("run action model", () => {
  it("reads the status to decide which controls exist", () => {
    expect(isActiveRun(run({ status: "implementing" }))).toBe(true);
    expect(isActiveRun(run({ status: "completed" }))).toBe(false);

    expect(canResume(run({ status: "interrupted", checkpoints: [{ id: "c" }] as never }))).toBe(true);
    expect(canResume(run({ status: "interrupted", checkpoints: [] }))).toBe(false);
    expect(canResume(run({ status: "blocked" }))).toBe(false);

    expect(canPublish(run({ status: "ready-to-merge" }))).toBe(true);
    expect(canPublish(run({ status: "ci-failed" }))).toBe(true);
    expect(canPublish(run({ status: "implementing" }))).toBe(false);

    expect(canRetry(run({ status: "blocked" }))).toBe(true);
    expect(canRetry(run({ status: "cancelled" }))).toBe(true);
    expect(canRetry(run({ status: "completed" }))).toBe(false);
  });

  it("words retry per status and labels the PR", () => {
    expect(retryLabel(run({ status: "interrupted" }))).toBe("重新开始");
    expect(retryLabel(run({ status: "blocked" }))).toBe("重试为新运行");
    expect(retryHint(run({ status: "interrupted" }))).toContain("放弃检查点");
    expect(retryHint(run({ status: "blocked" }))).toContain("新开一条关联 run");
    expect(pruneLabel(run({ pullRequestNumber: 12 } as never))).toBe("PR #12");
    expect(pruneLabel(run())).toBe("PR");
  });
});

describe("copyText", () => {
  it("uses the clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to the legacy selection path", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = vi.fn().mockReturnValue(true);
    await expect(copyText("legacy")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when both paths fail", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error("nope");
    });
    await expect(copyText("x")).resolves.toBe(false);
  });
});

describe("RunActions", () => {
  it("shows the PR link and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderActions(props({ run: run({ pullRequestUrl: "https://pr/1", pullRequestNumber: 1 } as never) }));
    await userEvent.click(screen.getByRole("button", { name: "复制 PR 链接" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "在新标签页打开 PR" })).toHaveAttribute("href", "https://pr/1");
  });

  it("offers the approval button when one is pending", async () => {
    const onReviewApproval = vi.fn();
    const approval = { id: "a-1", gate: "final" } as never;
    renderActions(props({ pendingApproval: approval, onReviewApproval }));
    await userEvent.click(screen.getByRole("button", { name: /处理审批/ }));
    expect(onReviewApproval).toHaveBeenCalledWith(approval);
  });

  it("shows resume, publish, pause, cancel and retry per status", async () => {
    const p = props({ run: run({ status: "interrupted", checkpoints: [{ id: "c" }] as never }) });
    const { unmount } = renderActions(p);
    expect(screen.getByRole("button", { name: /从检查点继续/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /重新开始/ })).toBeTruthy();
    unmount();

    renderActions(props({ run: run({ status: "ready-to-merge" }) }));
    expect(screen.getByRole("button", { name: /发布/ })).toBeTruthy();
  });

  it("pauses and cancels an active run", async () => {
    const p = props({ run: run({ status: "implementing" }) });
    renderActions(p);
    await userEvent.click(screen.getByRole("button", { name: /暂停/ }));
    await userEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(p.onPause).toHaveBeenCalled();
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("disables every control while busy", () => {
    renderActions(props({ busy: true, run: run({ status: "implementing" }) }));
    expect(screen.getByRole("button", { name: /暂停/ })).toBeDisabled();
  });
});
