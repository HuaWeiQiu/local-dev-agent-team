import { describe, expect, it } from "vitest";
import { terminalStatusAfterFailure } from "../src/workflow/runner.js";

describe("terminalStatusAfterFailure", () => {
  it("maps explicit user cancel to cancelled", () => {
    const controller = new AbortController();
    controller.abort(new Error("Run cancelled by user"));
    expect(terminalStatusAfterFailure(controller.signal.reason, controller.signal)).toBe(
      "cancelled",
    );
  });

  it("maps control-service shutdown to interrupted for checkpoint resume", () => {
    const controller = new AbortController();
    controller.abort(new Error("Control service is shutting down"));
    expect(terminalStatusAfterFailure(controller.signal.reason, controller.signal)).toBe(
      "interrupted",
    );
  });

  it("maps non-abort failures to blocked", () => {
    expect(terminalStatusAfterFailure(new Error("quality failed"))).toBe("blocked");
  });
});
