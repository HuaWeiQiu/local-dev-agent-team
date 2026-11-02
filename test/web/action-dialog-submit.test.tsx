// @vitest-environment jsdom
import "./dom-setup.js";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditablePlan } from "../../web/src/components/PlanEditor.js";
import type { DialogView } from "../../web/src/components/run/action-dialog/model.js";
import { useSubmit } from "../../web/src/components/run/action-dialog/dialog.js";

function view(patch: Partial<DialogView> = {}): DialogView {
  return {
    editable: false,
    edited: false,
    draftProblem: undefined,
    approveBlocked: false,
    submitLabel: "提交",
    ...patch,
  } as DialogView;
}

function plan(): EditablePlan {
  return { tasks: [] } as unknown as EditablePlan;
}

function submit(input: {
  actor?: string;
  reason?: string;
  draft?: EditablePlan | undefined;
  view?: DialogView;
}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useSubmit({
      actor: input.actor ?? "operator",
      reason: input.reason ?? "because",
      draft: "draft" in input ? input.draft : undefined,
      view: input.view ?? view(),
      onSubmit,
    }),
  );
  return { run: result.current, onSubmit };
}

describe("useSubmit", () => {
  it("sends a plain decision with the actor and the reason", async () => {
    const { run, onSubmit } = submit({});

    await run("rejected");

    expect(onSubmit).toHaveBeenCalledWith({
      decision: "rejected",
      actor: "operator",
      reason: "because",
    });
  });

  it("sends no decision when the caller did not pick one", async () => {
    const { run, onSubmit } = submit({});

    await run();

    expect(onSubmit).toHaveBeenCalledWith({ actor: "operator", reason: "because" });
  });

  it("attaches the edited plan only for an approval of an edited draft", async () => {
    const draft = plan();
    const { run, onSubmit } = submit({ draft, view: view({ editable: true, edited: true }) });

    await run("approved");

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved", plan: draft }),
    );
  });

  it("sends the draft-less approval when the dialog was never edited", async () => {
    const { run, onSubmit } = submit({ draft: plan(), view: view({ editable: true }) });

    await run("approved");

    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("plan");
  });

  it("does nothing when the payload is incomplete", async () => {
    const { run, onSubmit } = submit({ actor: "  " });

    await run("approved");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses to submit an approval the view marks as blocked", async () => {
    const { run, onSubmit } = submit({ view: view({ approveBlocked: true }) });

    await run("approved");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("still submits a rejection while approvals are blocked", async () => {
    const { run, onSubmit } = submit({ view: view({ approveBlocked: true }) });

    await run("rejected");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
