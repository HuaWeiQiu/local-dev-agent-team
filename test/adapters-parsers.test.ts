import { describe, expect, it } from "vitest";
import {
  parseClaudeJson,
  parseGrokJson,
  parseKimiStreamJson,
  parseOutputFileResult,
} from "../src/adapters/shared.js";
import type { AgentInvocation } from "../src/adapters/types.js";

function result(stdout: string, patch: Record<string, unknown> = {}) {
  return { command: "x", args: [], cwd: "/repo", exitCode: 0, stdout, stderr: "", durationMs: 1, ...patch };
}

function invocation(patch: Record<string, unknown> = {}) {
  return { command: "x", args: [], cwd: "/repo", ...patch } as AgentInvocation;
}

describe("parseClaudeJson", () => {
  it("reads the envelope, its structured output and usage", () => {
    const parsed = parseClaudeJson(
      result(
        JSON.stringify({
          result: "完成",
          structured_output: { answer: 42 },
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );
    expect(parsed.text).toBe("完成");
    expect(parsed.structured).toEqual({ answer: 42 });
    expect(parsed.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("falls back to raw text for empty or non-JSON output", () => {
    expect(parseClaudeJson(result("   "))).toMatchObject({ text: "" });
    const raw = parseClaudeJson(result("not json"));
    expect(raw.text).toBe("not json");
    expect(raw.structured).toBeUndefined();
  });

  it("accepts the camelCase structured field", () => {
    const parsed = parseClaudeJson(result(JSON.stringify({ structuredOutput: { a: 1 } })));
    expect(parsed.structured).toEqual({ a: 1 });
  });
});

describe("parseKimiStreamJson", () => {
  it("joins assistant chunks from NDJSON lines", () => {
    const parsed = parseKimiStreamJson(
      result(['{"role":"meta","text":"ignore"}', '{"role":"assistant","content":"答"}', '{"type":"assistant","content":"案"}'].join("\n")),
    );
    expect(parsed.text).toBe("答案");
  });

  it("keeps plain text chunks and skips non-JSON lines", () => {
    const parsed = parseKimiStreamJson(result(['noise', '{"text":"正文"}'].join("\n")));
    expect(parsed.text).toBe("正文");
  });

  it("extracts a fenced json block or a trailing object", () => {
    const fenced = parseKimiStreamJson(result('前言\n```json\n{"a":1}\n```\n'));
    expect(fenced.structured).toEqual({ a: 1 });

    const trailing = parseKimiStreamJson(result('思考\n{"b":2}'));
    expect(trailing.structured).toEqual({ b: 2 });

    const plain = parseKimiStreamJson(result('{"c":3}'));
    expect(plain.structured).toEqual({ c: 3 });
  });

  it("throws for an empty successful stream but tolerates a failed one", () => {
    expect(() => parseKimiStreamJson(result("  "))).toThrow(/no stream-json output/);
    expect(parseKimiStreamJson(result("", { exitCode: 1 }))).toMatchObject({ text: "" });
  });

  it("returns the raw stream when nothing is parseable as json", () => {
    const parsed = parseKimiStreamJson(result("只有文字"));
    expect(parsed.text).toBe("只有文字");
    expect(parsed.structured).toBeUndefined();
  });
});

describe("parseOutputFileResult", () => {
  it("reads stdout when there is no output file", async () => {
    const parsed = await parseOutputFileResult(invocation(), result("hello"));
    expect(parsed).toMatchObject({ text: "hello" });
  });

  it("prefers the output file and parses it", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/agent-team-out-"));
    const file = `${dir}/out.json`;
    await import("node:fs/promises").then((fs) => fs.writeFile(file, '{"ok":true}', "utf8"));
    const parsed = await parseOutputFileResult(invocation({ outputFile: file }), result("stdout wins?"));
    expect(parsed.text).toBe('{"ok":true}');
    expect(parsed.structured).toEqual({ ok: true });
  });

  it("keeps stdout when the output file is missing", async () => {
    const parsed = await parseOutputFileResult(
      invocation({ outputFile: "/tmp/definitely-missing-agent-team.json" }),
      result("fallback"),
    );
    expect(parsed.text).toBe("fallback");
  });
});

describe("parseGrokJson", () => {
  it("parses a completed stop with text and usage", () => {
    const parsed = parseGrokJson(
      result(JSON.stringify({ stopReason: "end_turn", text: "完成", usage: { input_tokens: 1, output_tokens: 2 } })),
    );
    expect(parsed.text).toBe("完成");
    expect(parsed.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  });

  it("reports a failed or unparsable grok stream", () => {
    expect(parseGrokJson(result("", { exitCode: 1 }))).toMatchObject({ text: "" });
    expect(() => parseGrokJson(result(""))).toThrow(/no JSON output/);
  });
});
