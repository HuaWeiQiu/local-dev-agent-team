import { describe, expect, it } from "vitest";
import {
  commandAvailable,
  ocrReviewCommand,
  qualityCommandAvailability,
} from "../src/quality/optional-tools.js";

describe("optional quality tools", () => {
  it("builds the recommended ocr quality command", () => {
    expect(ocrReviewCommand()).toEqual({ command: "ocr", args: ["review"] });
    expect(ocrReviewCommand(["--from", "main"])).toEqual({
      command: "ocr",
      args: ["review", "--from", "main"],
    });
  });

  it("reports PATH availability for configured quality commands", async () => {
    const nodeAvailable = await commandAvailable("node");
    expect(nodeAvailable).toBe(true);
    const report = await qualityCommandAvailability([
      { command: "node", args: ["-v"] },
      { command: "ocr", args: ["review"] },
    ]);
    expect(report.find((item) => item.command === "node")?.available).toBe(true);
    const ocr = report.find((item) => item.command === "ocr");
    expect(ocr).toBeDefined();
    if (!ocr?.available) {
      expect(ocr?.hint).toMatch(/open-code-review/i);
    }
  });
});
