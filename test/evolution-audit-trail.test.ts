import { describe, expect, it } from "vitest";
import { auditTrailViolation } from "../src/evolution/audit-trail.js";

function message(kinds: string[]): string | undefined {
  return auditTrailViolation(kinds)?.message("p-1");
}

describe("auditTrailViolation", () => {
  it("accepts the well-formed shapes", () => {
    expect(auditTrailViolation(["rejection", "delete"])).toBeUndefined();
    expect(auditTrailViolation(["rejection", "archive", "delete"])).toBeUndefined();
    expect(auditTrailViolation(["rejection", "archive", "unarchive", "delete"])).toBeUndefined();
  });

  it("requires a rejection first", () => {
    expect(auditTrailViolation([])?.index).toBe(0);
    expect(message(["archive", "delete"])).toContain("without its rejection");
  });

  it("requires the tombstone last", () => {
    expect(auditTrailViolation(["rejection", "archive"])?.index).toBe(1);
    expect(message(["rejection", "archive"])).toContain("references missing proposal");
  });

  it("rejects a repeated rejection", () => {
    expect(auditTrailViolation(["rejection", "rejection", "delete"])?.message("p-1")).toContain(
      "duplicates rejection",
    );
  });

  it("rejects anything after the deletion", () => {
    const violation = auditTrailViolation(["rejection", "delete", "archive", "delete"]);
    expect(violation?.index).toBe(1);
    expect(violation?.message("p-1")).toContain("after its deletion");
  });

  it("rejects a duplicated archive and an out-of-order unarchive", () => {
    expect(message(["rejection", "archive", "archive", "delete"])).toContain("duplicates archive");
    expect(message(["rejection", "unarchive", "delete"])).toContain("unarchives non-archived");
  });

  it("names the proposal in every message", () => {
    expect(auditTrailViolation(["archive"])?.message("run-9")).toContain("run-9");
  });
});
