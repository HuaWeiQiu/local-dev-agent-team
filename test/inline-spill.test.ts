import { describe, expect, it } from "vitest";
import { inlineWithin, safeCut, spillNote } from "../src/runtime/spill.js";

const ref = { kind: "task" as const, id: "T1" };

describe("inlineWithin", () => {
  it("keeps a short text whole and says nothing about spilling", () => {
    const result = inlineWithin({ text: "short feedback", maxChars: 100, ref });
    expect(result).toEqual({ head: "short feedback" });
  });

  it("keeps the head and describes the rest", () => {
    const text = "a".repeat(300);
    const result = inlineWithin({ text, maxChars: 100, ref });
    expect(result.head).toHaveLength(100);
    expect(result.spilled?.chars).toBe(200);
    expect(result.spilled?.lines).toBe(1);
    expect(result.spilled?.ref.summary).toContain("truncated 200 chars");
  });

  it("counts the lines it left out", () => {
    const text = ["one", "two", "three", "four"].join("\n");
    const result = inlineWithin({ text, maxChars: 7, ref });
    expect(result.spilled?.lines).toBeGreaterThan(1);
  });

  it("never splits an emoji in half", () => {
    // A surrogate pair sits across the cut: 🚀 is two code units.
    const text = `${"a".repeat(9)}🚀${"b".repeat(20)}`;
    const result = inlineWithin({ text, maxChars: 10, ref });
    expect(result.head).toBe("a".repeat(9));
    expect(result.head.includes("\ud83d")).toBe(false);
    expect(result.spilled?.chars).toBe(text.length - 9);
  });

  it("prefers a nearby line break over cutting mid-word", () => {
    const text = `${"x".repeat(90)}\nthe rest of the failure`;
    const result = inlineWithin({ text, maxChars: 95, ref });
    expect(result.head.endsWith("x")).toBe(true);
    expect(result.head.includes("\n")).toBe(false);
  });

  it("falls back to a hard cut when no break is close", () => {
    const text = "a".repeat(1000);
    expect(safeCut(text, 100)).toBe(100);
  });

  it("asks for nothing when the budget is zero", () => {
    const result = inlineWithin({ text: "anything", maxChars: 0, ref });
    expect(result.head).toBe("");
    expect(result.spilled?.chars).toBe(8);
  });
});

describe("spillNote", () => {
  it("says how much was left out and where to read it", () => {
    const result = inlineWithin({ text: "a".repeat(300), maxChars: 50, ref });
    const note = spillNote(result.spilled!);
    expect(note).toContain("task/T1");
    expect(note).toContain("truncated 250 chars");
  });
});
