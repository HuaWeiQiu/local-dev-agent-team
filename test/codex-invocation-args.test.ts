import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { AgentProfile } from "../src/config/schema.js";

const baseProfile: AgentProfile = {
  adapter: "codex",
  model: "inherit",
  reasoning: "high",
  permission: "workspace-write",
  externalTools: "inherit",
  timeoutSeconds: 60,
  args: [],
};

function invocation(
  profile: Partial<AgentProfile>,
  request: { outputSchema?: Record<string, unknown>; outputFile?: string },
) {
  return new CodexAdapter().buildInvocation(
    { ...baseProfile, ...profile },
    { cwd: "/tmp/repo", prompt: "Do the work", ...request },
  );
}

describe("codex invocation output handling", () => {
  it("writes both the schema sidecar and the last message when structured output is asked for", () => {
    const built = invocation(
      {},
      { outputSchema: { type: "object" }, outputFile: "/tmp/repo/out.json" },
    );

    expect(built.args).toContain("--output-schema");
    expect(built.args).toContain("/tmp/repo/out.json.schema.json");
    expect(built.args).toContain("--output-last-message");
    expect(built.args.at(-1)).toBe("-");
  });

  it("refuses structured output without a file to write the schema next to", () => {
    expect(() => invocation({}, { outputSchema: { type: "object" } })).toThrow(
      "Codex structured output requires an output file",
    );
  });

  it("still records the last message when only a file is given", () => {
    const built = invocation({}, { outputFile: "/tmp/repo/last.txt" });

    expect(built.args).toContain("--output-last-message");
    expect(built.args).toContain("/tmp/repo/last.txt");
    expect(built.args).not.toContain("--output-schema");
  });

  it("adds no output flags when neither is given", () => {
    const built = invocation({}, {});

    expect(built.outputFile).toBeUndefined();
    expect(built.args).not.toContain("--output-last-message");
    expect(built.args).not.toContain("--output-schema");
  });

  it("reports the output file on the invocation when there is one", () => {
    const built = invocation({}, { outputFile: "/tmp/repo/last.txt" });

    expect(built.outputFile).toBe("/tmp/repo/last.txt");
  });
});

describe("codex invocation identity flags", () => {
  it("passes the native profile and the configured model when both are set", () => {
    const built = invocation({ nativeProfile: "native", model: "gpt-5-codex" }, {});

    expect(built.args).toEqual(expect.arrayContaining(["--profile", "native"]));
    expect(built.args).toEqual(expect.arrayContaining(["--model", "gpt-5-codex"]));
  });

  it("omits the model flag for inherit and the profile flag when no native profile exists", () => {
    const built = invocation({}, {});

    expect(built.args).not.toContain("--model");
    expect(built.args).not.toContain("--profile");
  });

  it("refuses an unsupported reasoning level through the shared profile rules", () => {
    expect(() => invocation({ reasoning: "turbo" }, {})).toThrow(
      "Adapter 'codex' does not support reasoning 'turbo'",
    );
  });

  it("refuses a native profile under a deny policy", () => {
    expect(() =>
      invocation({ externalTools: "deny", nativeProfile: "native" }, {}),
    ).toThrow("Codex nativeProfile requires externalTools: inherit");
  });

  it("isolates the child from user configuration under a deny policy", () => {
    const built = invocation({ externalTools: "deny" }, {});

    expect(built.args).toContain("--ignore-user-config");
    expect(built.args).toContain('projects."/tmp/repo".trust_level="untrusted"');
  });
});
