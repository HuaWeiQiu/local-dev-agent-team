// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComposerToolbar } from "../web/src/components/strategy/ComposerToolbar.js";
import { TooltipProvider } from "../web/src/ui/tooltip.js";
import { PILL_TEXT, PILL_TONE, pillState, pillText } from "../web/src/components/strategy/composer/status-pill.js";

function toolbar(patch: Record<string, unknown> = {}) {
  return {
    strategyNames: ["balanced", "fast"],
    selectedName: "balanced",
    libraryOpen: false,
    inspectorOpen: false,
    submitting: false,
    dirty: false,
    canSubmit: true,
    feedback: undefined,
    onSelect: () => undefined,
    onToggleLibrary: () => undefined,
    onToggleInspector: () => undefined,
    onPreflight: () => undefined,
    onSave: () => undefined,
    onLaunch: () => undefined,
    ...patch,
  } as never;
}

describe("status pill model", () => {
  it("resolves the state with submitting first and feedback before dirtiness", () => {
    expect(pillState({ feedback: undefined, dirty: true, submitting: true })).toBe("submitting");
    expect(pillState({ feedback: { kind: "error", message: "x" }, dirty: true, submitting: false })).toBe("failed");
    expect(pillState({ feedback: { kind: "saved", message: "ok" }, dirty: true, submitting: false })).toBe("reported");
    expect(pillState({ feedback: undefined, dirty: true, submitting: false })).toBe("dirty");
    expect(pillState({ feedback: undefined, dirty: false, submitting: false })).toBe("clean");
  });

  it("prefers the reported message and falls back to the static text", () => {
    expect(pillText("reported", { kind: "valid", message: "服务端预检通过" })).toBe("服务端预检通过");
    expect(pillText("reported", undefined)).toBe(PILL_TEXT.clean);
    expect(pillText("dirty", undefined)).toBe(PILL_TEXT.dirty);
    expect(pillText("submitting", undefined)).toBe("提交中");
  });

  it("assigns a tone per state", () => {
    expect(PILL_TONE.failed).toBe("danger");
    expect(PILL_TONE.reported).toBe("success");
    expect(PILL_TONE.dirty).toBe("warning");
    expect(PILL_TONE.clean).toBe("neutral");
    expect(PILL_TONE.submitting).toBe("neutral");
  });
});

describe("ComposerToolbar", () => {
  it("says the strategy is loaded when nothing is pending", () => {
    render(<TooltipProvider><ComposerToolbar {...(toolbar() as object)} /></TooltipProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("已加载策略");
  });

  it("warns about an unverified draft", () => {
    render(<TooltipProvider><ComposerToolbar {...(toolbar({ dirty: true }) as object)} /></TooltipProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("草稿待预检");
  });

  it("shows the last result and the failure state", () => {
    const { unmount } = render(
      <TooltipProvider>
        <ComposerToolbar {...(toolbar({ feedback: { kind: "saved", message: "已保存并编译" } }) as object)} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("已保存并编译");
    unmount();

    render(<TooltipProvider><ComposerToolbar {...(toolbar({ feedback: { kind: "error", message: "预检失败" } }) as object)} /></TooltipProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("操作失败");
  });

  it("locks the controls while submitting", () => {
    render(<TooltipProvider><ComposerToolbar {...(toolbar({ submitting: true }) as object)} /></TooltipProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("提交中");
  });
});
