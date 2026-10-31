// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionPanel } from "../../web/src/components/evolution/ActionPanel.js";
import {
  actionKey,
  canDelete,
  failureDescription,
  failureTitle,
  isReviewable,
} from "../../web/src/components/evolution/action/model.js";
import type { EvolutionProposal } from "../../web/src/types.js";

function proposal(patch: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return { id: "p-1", status: "proposed", candidate: { kind: "role-prompt" }, ...patch } as EvolutionProposal;
}

function handlers() {
  return {
    onEvaluate: vi.fn(),
    onPromote: vi.fn(),
    onRollback: vi.fn(),
    onReject: vi.fn(),
    onAdopt: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
  };
}

function panel(p: EvolutionProposal, h = handlers()) {
  return render(<ActionPanel proposal={p} locked={false} busy={false} compact={false} {...h} />);
}

describe("action key", () => {
  it("walks the status machine", () => {
    expect(actionKey(proposal({ status: "proposed" }))).toBe("preflight");
    expect(actionKey(proposal({ status: "evaluating" }))).toBe("resume-preflight");
    expect(
      actionKey(
        proposal({
          status: "evaluated",
          evaluation: { source: "server-structural-preflight-v1", result: { passed: true } } as never,
        }),
      ),
    ).toBe("review-ready");
    expect(
      actionKey(
        proposal({
          status: "evaluated",
          evaluation: { source: "server-automatic-run-evaluation-v1", result: { passed: true } } as never,
        }),
      ),
    ).toBe("auto-comparing");
    expect(
      actionKey(
        proposal({
          status: "evaluated",
          evaluation: { source: "external", result: { passed: true } } as never,
        }),
      ),
    ).toBe("preflight-failed");
    expect(
      actionKey(proposal({ status: "promoted", application: { rollbackSafe: true } as never })),
    ).toBe("rollback");
    expect(actionKey(proposal({ status: "promoted" }))).toBe("adopt");
    expect(actionKey(proposal({ status: "rejected" }))).toBe("closed");
  });

  it("decides reviewability, deletion and failure copy", () => {
    expect(isReviewable("evaluated")).toBe(true);
    expect(isReviewable("promoted")).toBe(true);
    expect(isReviewable("rejected")).toBe(true);
    expect(isReviewable("rolled-back")).toBe(true);
    expect(isReviewable("proposed")).toBe(false);
    expect(canDelete(proposal({ status: "rejected" }))).toBe(true);
    expect(canDelete(proposal({ status: "evaluated" }))).toBe(false);

    expect(
      failureTitle(proposal({ evaluation: { source: "external" } as never })),
    ).toBe("需要当前结构预检");
    expect(failureTitle(proposal())).toBe("预检未通过");
    expect(
      failureDescription(
        proposal({ evaluation: { result: { summary: "缺证据" } } as never }),
      ),
    ).toBe("缺证据");
    expect(failureDescription(proposal())).toMatch(/没有可用于应用/);
  });
});

describe("ActionPanel", () => {
  it("starts a preflight for a proposed candidate", async () => {
    const h = handlers();
    panel(proposal({ status: "proposed" }), h);
    await userEvent.click(screen.getByRole("button", { name: /开始预检/ }));
    expect(h.onEvaluate).toHaveBeenCalled();
  });

  it("offers promote and reject once the structural preflight passed", () => {
    panel(
      proposal({
        status: "evaluated",
        evaluation: { source: "server-structural-preflight-v1", result: { passed: true } } as never,
      }),
    );
    expect(screen.getByRole("button", { name: /查看并应用/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝候选/ })).toBeTruthy();
  });

  it("waits while the automatic comparison runs", () => {
    panel(
      proposal({
        status: "evaluated",
        evaluation: { source: "server-automatic-run-evaluation-v1", result: { passed: false } } as never,
      }),
    );
    expect(screen.getByText("自动比较中")).toBeVisible();
  });

  it("explains a failed preflight with its summary", () => {
    panel(
      proposal({
        status: "evaluated",
        evaluation: { source: "external", result: { passed: false, summary: "结构缺失" } } as never,
      }),
    );
    expect(screen.getByText("需要当前结构预检")).toBeVisible();
    expect(screen.getByText("结构缺失")).toBeVisible();
  });

  it("offers rollback and adoption for promoted candidates", () => {
    const { unmount } = panel(
      proposal({ status: "promoted", application: { rollbackSafe: true } as never }),
    );
    expect(screen.getByRole("button", { name: /预览回滚/ })).toBeTruthy();
    unmount();

    panel(proposal({ status: "promoted" }));
    expect(screen.getByRole("button", { name: /采纳当前目标/ })).toBeTruthy();
  });

  it("archives a finished candidate and only deletes after reject", () => {
    const { unmount } = panel(proposal({ status: "promoted", application: {} as never }));
    expect(screen.getByRole("button", { name: /归档/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /删除候选/ })).toBeNull();
    unmount();

    panel(proposal({ status: "rejected" }));
    expect(screen.getByRole("button", { name: /删除候选/ })).toBeTruthy();
    expect(screen.getByText("流程已结束")).toBeVisible();
  });

  it("disables every action when locked", () => {
    render(
      <ActionPanel
        proposal={proposal({ status: "proposed" })}
        locked
        busy={false}
        compact={false}
        {...handlers()}
      />,
    );
    expect(screen.getByRole("button", { name: /开始预检/ })).toBeDisabled();
  });
});
