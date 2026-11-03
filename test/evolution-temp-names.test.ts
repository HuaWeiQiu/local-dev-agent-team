import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  promptTempName,
  promptTempPattern,
  siblingTempName,
  siblingTempPattern,
} from "../src/evolution/temp-names.js";

/**
 * The contract these tests exist for: **every name the writer can produce must be a name the
 * cleaner recognises**. If they drift, a crashed write leaves a temp file nobody deletes, and
 * the only symptom is a disk that slowly fills with files nobody can attribute. Nothing will
 * fail, so this test is the only thing that will.
 */
describe("temp file names", () => {
  it("matches every prompt temp the writer can produce", () => {
    for (const basename of ["a.md", "worker.md", "with space.md"]) {
      for (const recovery of [false, true]) {
        expect(promptTempName(basename, { recovery })).toMatch(
          promptTempPattern(basename, { allowRecovery: true }),
        );
      }
    }
  });

  it("matches every plain sibling temp the writer can produce", () => {
    // The cleaner walks a directory and tests entry names, so the pattern is applied to the
    // basename of what the writer produced.
    for (const absolute of ["/repo/.metrics/crap.edn", "/repo/x.json"]) {
      const name = path.basename(siblingTempName(absolute));
      expect(name).toMatch(siblingTempPattern(path.basename(absolute)));
    }
  });

  it("does not let one family's name pass as the other's", () => {
    // A hidden prompt temp must not be mistaken for a plain sibling temp, and vice versa:
    // the cleaners run in different directories with different rules.
    expect(promptTempName("a.md")).not.toMatch(siblingTempPattern("a.md"));
    expect(siblingTempName("/repo/a.md")).not.toMatch(promptTempPattern("a.md", { allowRecovery: true }));
  });

  it("keeps the recovery name distinguishable when the pattern asks for it", () => {
    expect(promptTempName("a.md", { recovery: true })).not.toMatch(promptTempPattern("a.md"));
    expect(promptTempName("a.md", { recovery: true })).toMatch(
      promptTempPattern("a.md", { allowRecovery: true }),
    );
  });

  it("matches only the file it was built for", () => {
    expect(promptTempName("a.md")).not.toMatch(promptTempPattern("b.md", { allowRecovery: true }));
    // A regex built from a name with regex metacharacters must not become a wildcard.
    expect(promptTempName("a+b.md")).toMatch(promptTempPattern("a+b.md", { allowRecovery: true }));
    expect(promptTempName("aXb.md")).not.toMatch(promptTempPattern("a+b.md", { allowRecovery: true }));
  });
});
