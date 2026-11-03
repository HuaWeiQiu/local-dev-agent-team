import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandAvailable, ocrReviewCommand, qualityCommandAvailability } from "../src/quality/optional-tools.js";

describe("commandAvailable", () => {
  it("finds a command on PATH", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-path-"));
    await writeFile(path.join(dir, "fake-cli"), "\n", "utf8");

    await expect(commandAvailable("fake-cli", { PATH: dir })).resolves.toBe(true);
  });

  it("reports a command that is not on PATH", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-path-"));

    await expect(commandAvailable("definitely-missing-cli", { PATH: dir })).resolves.toBe(false);
  });

  it("checks a path-like command directly", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-path-"));
    const binary = path.join(dir, "tool");
    await writeFile(binary, "\n", "utf8");

    await expect(commandAvailable(binary, {})).resolves.toBe(true);
    await expect(commandAvailable(path.join(dir, "missing"), {})).resolves.toBe(false);
  });

  it("treats an empty PATH as no candidates", async () => {
    await expect(commandAvailable("anything", {})).resolves.toBe(false);
  });

  it("honours the Windows Path spelling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-path-"));
    await writeFile(path.join(dir, "win-cli"), "\n", "utf8");

    await expect(commandAvailable("win-cli", { Path: dir })).resolves.toBe(true);
  });
});

describe("qualityCommandAvailability", () => {
  it("reports availability per command and hints how to install OCR", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-path-"));

    const results = await qualityCommandAvailability(
      [ocrReviewCommand(), { command: "definitely-missing-cli", args: [] }],
      { PATH: dir },
    );

    expect(results).toEqual([
      { command: "ocr", available: false, hint: expect.stringContaining("open-code-review") },
      { command: "definitely-missing-cli", available: false },
    ]);
  });

  it("leaves the hint off once the optional tool is installed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-team-path-"));
    await writeFile(path.join(dir, "ocr"), "\n", "utf8");

    const [result] = await qualityCommandAvailability([ocrReviewCommand(["--json"])], { PATH: dir });

    expect(result).toEqual({ command: "ocr", available: true });
    expect(ocrReviewCommand(["--json"]).args).toEqual(["review", "--json"]);
  });
});
