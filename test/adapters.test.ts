import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { AgentProfile } from "../src/config/schema.js";

const readOnlyProfile: AgentProfile = {
  adapter: "codex",
  model: "configured-model",
  reasoning: "high",
  permission: "read-only",
  timeoutSeconds: 60,
  args: [],
};

describe("Codex adapter", () => {
  it("passes explicit model and sandbox without a shell", () => {
    const invocation = new CodexAdapter().buildInvocation(readOnlyProfile, {
      cwd: "/tmp/repo",
      prompt: "Review",
    });
    expect(invocation.command).toBe("codex");
    expect(invocation.args).toContain("configured-model");
    expect(invocation.args).toContain("read-only");
    expect(invocation.stdin).toBe("Review");
  });

  it("inherits the CLI model when requested", () => {
    const invocation = new CodexAdapter().buildInvocation(
      { ...readOnlyProfile, model: "inherit" },
      { cwd: "/tmp/repo", prompt: "Review" },
    );
    expect(invocation.args).not.toContain("--model");
  });

  it("rejects safety overrides in profile arguments", () => {
    expect(() =>
      new CodexAdapter().buildInvocation(
        { ...readOnlyProfile, args: ["--sandbox", "danger-full-access"] },
        { cwd: "/tmp/repo", prompt: "Review" },
      ),
    ).toThrow("cannot be overridden");
  });
});

describe("Claude adapter", () => {
  it("maps read-only profiles to plan mode", () => {
    const invocation = new ClaudeAdapter().buildInvocation(
      { ...readOnlyProfile, adapter: "claude", reasoning: "max" },
      { cwd: "/tmp/repo", prompt: "Review" },
    );
    expect(invocation.command).toBe("claude");
    expect(invocation.args).toContain("plan");
    expect(invocation.args).toContain("max");
    expect(invocation.args).toContain("Read,Glob,Grep");
    expect(invocation.args).toContain("Edit,Write,NotebookEdit,Bash");
    expect(invocation.args).not.toContain("Review");
    expect(invocation.stdin).toBe("Review");
  });
});
