// @vitest-environment jsdom
import "./dom-setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../../web/src/ui/dialog.js";

/**
 * `web/src/ui/dialog.tsx` had no test of its own: its coverage came from whichever
 * consumer happened to render which variant, and one line (`className={cn(...)}`)
 * flipped between two full runs of the suite. Rendering it directly and asserting the
 * behaviour of its guards is what makes that line either covered or not — not luck.
 */
function renderModal(
  overrides: Partial<Parameters<typeof Modal>[0]> = {},
  children: ReactNode = <p>body</p>,
) {
  const onOpenChange = vi.fn();
  render(
    <Modal open onOpenChange={onOpenChange} title="确认操作" {...overrides}>
      {children}
    </Modal>,
  );
  return { onOpenChange };
}

describe("Modal", () => {
  it("renders the title, body and footer", async () => {
    renderModal({ footer: <button type="button">确定</button> });
    expect(await screen.findByRole("heading", { name: "确认操作" })).toBeVisible();
    expect(screen.getByText("body")).toBeVisible();
    expect(screen.getByRole("button", { name: "确定" })).toBeVisible();
  });

  it("describes the dialog only when a description was given", async () => {
    const { unmount } = render(
      <Modal open onOpenChange={() => undefined} title="有描述" description="说明文字">
        <p>body</p>
      </Modal>,
    );
    const described = await screen.findByRole("dialog");
    expect(described).toHaveAccessibleDescription("说明文字");
    unmount();

    renderModal();
    const bare = await screen.findByRole("dialog");
    expect(bare).not.toHaveAttribute("aria-describedby");
  });

  it("keeps the dialog open on Escape while locked", async () => {
    const { onOpenChange } = renderModal({ locked: true });
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    // The guard called preventDefault, so Radix never asked to close.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on Escape when it is not locked", async () => {
    const { onOpenChange } = renderModal();
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("ignores an outside interaction while locked", async () => {
    const { onOpenChange } = renderModal({ locked: true });
    await screen.findByRole("dialog");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("moves focus to the [data-autofocus] child", async () => {
    renderModal(
      {},
      <button type="button" data-autofocus>
        主操作
      </button>,
    );
    const target = await screen.findByRole("button", { name: "主操作" });
    await waitFor(() => expect(target).toHaveFocus());
  });

  it("keeps the caller's className next to the modal's own", async () => {
    renderModal({ className: "custom-modal" });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("custom-modal");
    expect(dialog.className).toContain("rounded-xl");
  });
});
