// @vitest-environment jsdom
import "./dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  EvolutionDecisionDialog,
  type EvolutionDecision,
} from "../../web/src/components/EvolutionDecisionDialog.js";
import {
  actionLabel,
  copyFor,
  dialogWidth,
  isDestructive,
  submitDisabled,
  trimmedReason,
} from "../../web/src/components/evolution/decision/model.js";
import { shortDigest } from "../../web/src/components/evolution/decision/sections.js";

function decision(patch: Partial<EvolutionDecision> = {}): EvolutionDecision {
  return { mode: "promote", proposalId: "p-1", commandId: "c-1", ...patch };
}

function preview(mode: "promote" | "rollback" = "promote") {
  return {
    preview: { token: "t", catalogRevision: 7, expiresAt: "2099-01-01T00:00:00.000Z" },
    description: {
      kind: mode === "promote" ? "promote-and-apply" : "rollback-applied",
      proposalId: "p-1",
      before: {
        kind: "role-prompt",
        identity: "prompts/worker.md",
        digest: "a".repeat(64),
        present: true,
        content: "old content",
      },
      after: {
        kind: "role-prompt",
        identity: "prompts/worker.md",
        digest: "b".repeat(64),
        present: true,
        content: "new content",
      },
    },
  } as never;
}

describe("decision dialog model", () => {
  it("maps each mode to its copy and tone", () => {
    expect(copyFor(undefined).action).toBe("确认应用");
    expect(copyFor(decision({ mode: "delete" })).title).toBe("删除候选");
    expect(isDestructive("reject")).toBe(true);
    expect(isDestructive("delete")).toBe(true);
    expect(isDestructive("promote")).toBe(false);
    expect(isDestructive(undefined)).toBe(false);
  });

  it("sizes the dialog and labels the action", () => {
    expect(dialogWidth(undefined)).toContain("540px");
    expect(dialogWidth(preview())).toContain("960px");
    expect(actionLabel(decision(), true)).toBe("提交中");
    expect(actionLabel(decision({ submittedReason: "first" }), false)).toBe("重试原确认");
    expect(actionLabel(decision(), false)).toBe("确认应用");
  });

  it("blocks submit without a reason and trims what it sends", () => {
    expect(submitDisabled(decision(), false, "  ")).toBe(true);
    expect(submitDisabled(undefined, false, "ok")).toBe(true);
    expect(submitDisabled(decision(), true, "ok")).toBe(true);
    expect(submitDisabled(decision(), false, "ok")).toBe(false);
    expect(trimmedReason("  why  ")).toBe("why");
    expect(trimmedReason("   ")).toBeUndefined();
  });

  it("renders a missing target and a blueprint diff", () => {
    const blueprintPreview = {
      ...(preview() as Record<string, unknown>),
      description: {
        kind: "promote-and-apply",
        proposalId: "p-1",
        before: { kind: "role-prompt", identity: "x", digest: null, present: false, content: null },
        after: {
          kind: "strategy-blueprint",
          identity: "blueprint://demo",
          digest: "c".repeat(64),
          present: true,
          definition: { name: "demo", maxParallel: 2 },
        },
      },
    };
    render(
      <EvolutionDecisionDialog
        decision={decision({ preview: blueprintPreview as never })}
        busy={false}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getAllByText("（目标不存在）").length).toBeGreaterThan(0);
    expect(screen.getByText(/maxParallel/)).toBeVisible();
  });

  it("shortens digests", () => {
    expect(shortDigest(null)).toBe("无摘要");
    expect(shortDigest("a".repeat(64))).toBe("aaaaaaaa…aaaaaa");
  });
});

describe("EvolutionDecisionDialog", () => {
  it("shows the preview panes for a promotion", () => {
    render(
      <EvolutionDecisionDialog
        decision={decision({ preview: preview() })}
        busy={false}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText(/服务端精确预览/)).toBeVisible();
    expect(screen.getByText("当前")).toBeVisible();
    expect(screen.getByText("应用后")).toBeVisible();
    expect(screen.getByText("old content")).toBeVisible();
    expect(screen.getByText("new content")).toBeVisible();
  });

  it("labels the right pane as rollback-after for a rollback", () => {
    render(
      <EvolutionDecisionDialog
        decision={decision({ mode: "rollback", preview: preview("rollback") })}
        busy={false}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText("回滚后")).toBeVisible();
  });

  it("explains adopt and delete without a preview", () => {
    const { rerender } = render(
      <EvolutionDecisionDialog
        decision={decision({ mode: "adopt" })}
        busy={false}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText(/登记现状/)).toBeVisible();

    rerender(
      <EvolutionDecisionDialog
        decision={decision({ mode: "delete" })}
        busy={false}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText(/删除不可恢复/)).toBeVisible();
  });

  it("submits the trimmed reason and disables the button while empty", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <EvolutionDecisionDialog
        decision={decision()}
        busy={false}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    const submit = screen.getByRole("button", { name: /确认应用/ });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("决定理由"), "  因为  ");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith("因为");
  });

  it("locks the reason once a decision was already submitted", () => {
    render(
      <EvolutionDecisionDialog
        decision={decision({ submittedReason: "first" })}
        busy={false}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("决定理由")).toBeDisabled();
    expect(screen.getByRole("button", { name: /重试原确认/ })).toBeTruthy();
  });

  it("renders nothing when no decision is pending", () => {
    const { container } = render(
      <EvolutionDecisionDialog
        decision={undefined}
        busy={false}
        error="boom"
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    expect(container.querySelector("form")).toBeNull();
  });
});
