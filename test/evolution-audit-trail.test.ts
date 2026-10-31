import { describe, expect, it } from "vitest";
import { auditTrailViolation, isRetainedTrailKind } from "../src/evolution/audit-trail.js";
import { assertDeletedAuditTrail, isUnsupportedDirectorySync } from "../src/evolution/persistence.js";

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

describe("shared trail rules", () => {
  it("allows only the retained kinds to outlive a proposal", () => {
    expect(isRetainedTrailKind("rejection")).toBe(true);
    expect(isRetainedTrailKind("archive")).toBe(true);
    expect(isRetainedTrailKind("unarchive")).toBe(true);
    expect(isRetainedTrailKind("delete")).toBe(true);
    expect(isRetainedTrailKind("promotion")).toBe(false);
    expect(isRetainedTrailKind("rollback")).toBe(false);
  });

  it("reports the persisted index of a bad trail", () => {
    const trail = [
      { index: 7, audit: { kind: "rejection" } },
      { index: 9, audit: { kind: "archive" } },
    ] as never;
    expect(() => assertDeletedAuditTrail("/catalog.json", "p-1", trail)).toThrow(
      /references missing proposal/,
    );
    expect(() =>
      assertDeletedAuditTrail("/catalog.json", "p-1", [{ index: 3, audit: { kind: "promotion" } }] as never),
    ).toThrow(/without its rejection/);
    const valid = [
      { index: 1, audit: { kind: "rejection" } },
      { index: 2, audit: { kind: "delete" } },
    ] as never;
    expect(() => assertDeletedAuditTrail("/catalog.json", "p-1", valid)).not.toThrow();
  });

  it("only tolerates the Windows directory-sync codes", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(isUnsupportedDirectorySync(Object.assign(new Error("x"), { code: "EISDIR" }))).toBe(true);
    expect(isUnsupportedDirectorySync(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isUnsupportedDirectorySync(new Error("no code"))).toBe(false);
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    expect(isUnsupportedDirectorySync(Object.assign(new Error("x"), { code: "EISDIR" }))).toBe(false);
  });
});
