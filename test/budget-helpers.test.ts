import { describe, expect, it } from "vitest";
import { errorMessage, streamBytes } from "../src/observability/budget.js";

describe("streamBytes", () => {
  it("prefers the counts the adapter reported", () => {
    expect(streamBytes({ stdoutBytes: 10, stderrBytes: 4 } as never)).toBe(14);
  });

  it("measures the streams when no count was given", () => {
    expect(streamBytes({ stdout: "abc", stderr: "de" } as never)).toBe(5);
  });

  it("mixes a reported count with a measured stream", () => {
    expect(streamBytes({ stdoutBytes: 3, stderr: "de" } as never)).toBe(5);
  });

  it("counts nothing when the process reported nothing", () => {
    expect(streamBytes(undefined)).toBe(0);
    expect(streamBytes({} as never)).toBe(0);
  });
});

describe("errorMessage", () => {
  it("keeps a short message whole", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });

  it("truncates a message over the limit", () => {
    const long = errorMessage(new Error("x".repeat(2_500)));
    expect(long.endsWith("[truncated]")).toBe(true);
    expect(long.length).toBeLessThan(2_500);
  });
});
