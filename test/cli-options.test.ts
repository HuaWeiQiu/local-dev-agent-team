import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExclusiveConfigOptions,
  collectOption,
  confirmRepairPush,
  parseNonNegativeSafeInteger,
  parsePort,
  parseProfileAssignments,
  parseTail,
  parseTemplateOption,
  printChecks,
} from "../src/cli/options.js";
import type { RepairPushSummary } from "../src/github/repair.js";

const question = vi.fn<(prompt: string) => Promise<string>>();
const close = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question, close }),
}));

function summary(): RepairPushSummary {
  return {
    remote: "origin",
    branch: "repair/r1",
    commitMessage: "fix: repair",
    changedFiles: ["a.ts", "b.ts"],
    additions: 3,
    deletions: 1,
  };
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

function withTty(stdin: NodeJS.ReadStream, tty: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", { configurable: true, value: tty });
  return () => {
    if (original) Object.defineProperty(stdin, "isTTY", original);
    else Reflect.deleteProperty(stdin, "isTTY");
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  question.mockReset();
  close.mockReset();
});

describe("parseProfileAssignments", () => {
  it("splits each role=profile pair once, keeping later equals signs in the profile", () => {
    expect(parseProfileAssignments(["worker=fast", "reviewer=deep=1"])).toEqual({
      worker: "fast",
      reviewer: "deep=1",
    });
  });

  it("accepts an empty list", () => {
    expect(parseProfileAssignments([])).toEqual({});
  });

  it.each(["worker", "=fast", "worker="])("rejects the malformed pair %s", (pair) => {
    expect(() => parseProfileAssignments([pair])).toThrow(`Invalid profile assignment '${pair}'`);
  });
});

describe("parseTemplateOption", () => {
  it.each(["auto", "quick", "standard", "full"] as const)("accepts %s", (value) => {
    expect(parseTemplateOption(value)).toBe(value);
  });

  it("names the four templates it knows", () => {
    expect(() => parseTemplateOption("turbo")).toThrow(
      "Unknown workflow template 'turbo'; use auto, quick, standard or full",
    );
  });
});

describe("collectOption", () => {
  it("appends instead of replacing so repeated flags accumulate", () => {
    expect(collectOption("b", ["a"])).toEqual(["a", "b"]);
    expect(collectOption("a", [])).toEqual(["a"]);
  });
});

describe("printChecks", () => {
  it("says so when no check was reported", () => {
    const stdout = captureStdout();
    printChecks([]);
    expect(stdout.text()).toBe("No GitHub checks reported.\n");
  });

  it("prints one padded line per check", () => {
    const stdout = captureStdout();
    printChecks([
      { bucket: "pass", name: "quality", state: "SUCCESS" },
      { bucket: "pending", name: "e2e", state: "QUEUED" },
    ]);
    expect(stdout.text()).toBe("PASS     quality: SUCCESS\nPENDING  e2e: QUEUED\n");
  });
});

describe("confirmRepairPush", () => {
  it("prints the summary and pushes when --yes was given", async () => {
    const stdout = captureStdout();
    await expect(confirmRepairPush(summary(), true)).resolves.toBe(true);
    expect(stdout.text()).toContain("remote: origin/repair/r1");
    expect(stdout.text()).toContain("changes: 2 file(s), +3 -1");
    expect(stdout.text()).toContain("    b.ts");
    expect(question).not.toHaveBeenCalled();
  });

  it("refuses a non-interactive session that asked for no --yes", async () => {
    captureStdout();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const restore = withTty(process.stdin, false);
    try {
      await expect(confirmRepairPush(summary(), false)).resolves.toBe(false);
    } finally {
      restore();
    }
    expect(stderr).toHaveBeenCalledWith(
      "Refusing to push without confirmation in a non-interactive session; re-run with --yes.\n",
    );
  });

  it.each([
    ["y", true],
    [" YES ", true],
    ["", false],
    ["n", false],
  ])("turns the interactive answer %j into %s", async (answer, expected) => {
    captureStdout();
    const restore = withTty(process.stdin, true);
    question.mockResolvedValue(answer);
    try {
      await expect(confirmRepairPush(summary(), false)).resolves.toBe(expected);
    } finally {
      restore();
    }
    expect(question).toHaveBeenCalledWith("Push this repair commit? [y/N] ");
    expect(close).toHaveBeenCalled();
  });
});

describe("parseTail", () => {
  it("accepts zero and positive integers", () => {
    expect(parseTail("0")).toBe(0);
    expect(parseTail("42")).toBe(42);
  });

  it("keeps Number semantics for an empty string, which the flag parser never sends", () => {
    expect(parseTail("")).toBe(0);
  });

  it.each(["-1", "1.5", "many"])("rejects %j", (value) => {
    expect(() => parseTail(value)).toThrow(`Invalid --tail value '${value}'`);
  });
});

describe("parsePort", () => {
  it("accepts the whole valid range", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("65535")).toBe(65_535);
  });

  it("reads an empty string as port zero, as Number does", () => {
    expect(parsePort("")).toBe(0);
  });

  it.each(["-1", "65536", "80.5"])("rejects %j", (value) => {
    expect(() => parsePort(value)).toThrow(`Invalid port '${value}'`);
  });
});

describe("parseNonNegativeSafeInteger", () => {
  it("accepts a safe integer and keeps the label in the error", () => {
    expect(parseNonNegativeSafeInteger("7", "--max-rework")).toBe(7);
    expect(() => parseNonNegativeSafeInteger("-7", "--max-rework")).toThrow(
      "Invalid --max-rework value '-7'; expected a non-negative safe integer",
    );
  });

  it("rejects values above the safe integer range", () => {
    expect(() => parseNonNegativeSafeInteger("9007199254740993", "--budget")).toThrow(
      "expected a non-negative safe integer",
    );
  });
});

describe("assertExclusiveConfigOptions", () => {
  it("lets one source through", () => {
    expect(() => assertExclusiveConfigOptions({ config: "a.yaml" })).not.toThrow();
    expect(() => assertExclusiveConfigOptions({})).not.toThrow();
  });

  it("rejects asking for both", () => {
    expect(() => assertExclusiveConfigOptions({ config: "a.yaml", workspace: "b" })).toThrow(
      "Use either --config or --workspace, not both",
    );
  });
});
