import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { createDefaultConfig } from "../src/config/defaults.js";
import { JevClient, parseDecision, parseLayaDecision } from "../src/jev/client.js";
import { resolveConsultation, type JevDecisionInput } from "../src/jev/policy.js";

const input: JevDecisionInput = {
  taskId: "alpha",
  taskTitle: "Alpha",
  attempt: 2,
  maxAttempts: 3,
  repeated: false,
  failureSummary: "npm test exited 1: assertion failed",
};

function chatResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe("resolveConsultation", () => {
  it("follows a confident Jev decision in both directions", () => {
    expect(
      resolveConsultation({
        repeated: false,
        jev: { decision: "consult", confidence: 0.9 },
        minConfidence: 0.8,
      }),
    ).toMatchObject({ consult: true, source: "jev" });
    expect(
      resolveConsultation({
        repeated: true,
        jev: { decision: "retry", confidence: 0.9 },
        minConfidence: 0.8,
      }),
    ).toMatchObject({ consult: false, source: "jev" });
  });

  it("keeps the deterministic result when Jev is missing or unsure", () => {
    for (const repeated of [true, false]) {
      expect(resolveConsultation({ repeated, jev: undefined, minConfidence: 0.8 })).toMatchObject({
        consult: repeated,
        source: "deterministic",
      });
      expect(
        resolveConsultation({
          repeated,
          jev: { decision: repeated ? "retry" : "consult", confidence: 0.79 },
          minConfidence: 0.8,
        }),
      ).toMatchObject({ consult: repeated, source: "deterministic" });
    }
  });
});

describe("parseDecision", () => {
  it("extracts JSON from fenced or chatty output", () => {
    expect(
      parseDecision('```json\n{"decision":"consult","confidence":0.7,"reason":"loop"}\n```'),
    ).toEqual({ decision: "consult", confidence: 0.7, reason: "loop" });
  });

  it("rejects unknown decisions, out-of-range confidence, and non-JSON", () => {
    expect(parseDecision('{"decision":"stop","confidence":0.9}')).toBeUndefined();
    expect(parseDecision('{"decision":"retry","confidence":3}')).toBeUndefined();
    expect(parseDecision("no json here")).toBeUndefined();
  });
});

describe("JevClient", () => {
  const config = { baseUrl: "http://127.0.0.1:9931/v1", model: "jev", timeoutMs: 1_000 };

  it("posts an OpenAI-compatible request and returns the decision", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const client = new JevClient(config, (async (url: URL | string, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body));
      return chatResponse('{"decision":"retry","confidence":0.92}');
    }) as typeof fetch);

    await expect(client.decide(input)).resolves.toEqual({ decision: "retry", confidence: 0.92 });
    expect(seenUrl).toBe("http://127.0.0.1:9931/v1/chat/completions");
    expect(seenBody).toMatchObject({ model: "jev", temperature: 0 });
  });

  it("returns undefined on HTTP errors, network errors, and bad payloads", async () => {
    const failing = [
      async () => chatResponse("x", 500),
      async () => {
        throw new Error("ECONNREFUSED");
      },
      async () => chatResponse("not json"),
      async () => chatResponse(42),
    ];
    for (const fetchImpl of failing) {
      const client = new JevClient(config, fetchImpl as unknown as typeof fetch);
      await expect(client.decide(input)).resolves.toBeUndefined();
    }
  });

  it("probe explains the failure reason", async () => {
    const make = (fetchImpl: unknown) => new JevClient(config, fetchImpl as typeof fetch);
    await expect(make(async () => chatResponse("x", 500)).probe()).resolves.toMatchObject({
      ok: false,
      error: "HTTP 500",
    });
    await expect(make(async () => chatResponse("not json")).probe()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("不是合法的决策 JSON"),
    });
    await expect(
      make(async () => {
        throw new Error("ECONNREFUSED");
      }).probe(),
    ).resolves.toMatchObject({ ok: false, error: "ECONNREFUSED" });
    await expect(
      make(async () => chatResponse('{"decision":"retry","confidence":0.7}')).probe(),
    ).resolves.toMatchObject({ ok: true, decision: { decision: "retry", confidence: 0.7 } });
  });

  it("gives up after the configured timeout", async () => {
    const client = new JevClient({ ...config, timeoutMs: 200 }, ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch);

    await expect(client.decide(input)).resolves.toBeUndefined();
  });
});

describe("Laya protocol", () => {
  const config = { baseUrl: "http://127.0.0.1:9932", model: "laya", timeoutMs: 1_000, protocol: "laya" as const };
  const answer = (choice: string, confidence: number, retry = 0.9) =>
    new Response(
      JSON.stringify({ answers: { route: { choice, confidence, probabilities: { retry, consult: 1 - retry } } } }),
    );

  it("posts typed questions to /decide and maps the answer", async () => {
    let seenUrl = "";
    let seenBody: { state?: string; questions?: Record<string, { type: string }> } = {};
    const client = new JevClient(config, (async (url: URL | string, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init?.body));
      return answer("retry", 0.93, 0.97);
    }) as typeof fetch);

    await expect(client.decide(input)).resolves.toEqual({
      decision: "retry",
      confidence: 0.93,
      reason: "Laya retry p=0.97",
    });
    expect(seenUrl).toBe("http://127.0.0.1:9932/decide");
    expect(seenBody.questions?.route?.type).toBe("choice");
    expect(JSON.parse(seenBody.state ?? "{}")).toMatchObject({ task: { id: "alpha" }, attempt: 2 });
  });

  it("treats malformed answers and HTTP errors as no decision", async () => {
    const make = (fetchImpl: unknown) => new JevClient(config, fetchImpl as typeof fetch);
    await expect(make(async () => answer("maybe", 0.9)).decide(input)).resolves.toBeUndefined();
    await expect(make(async () => new Response("{}", { status: 400 })).probe()).resolves.toMatchObject({
      ok: false,
      error: "HTTP 400",
    });
    await expect(make(async () => new Response("{}")).probe()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("answers.route"),
    });
  });

  it("clamps confidence into range", () => {
    expect(parseLayaDecision({ answers: { route: { choice: "consult", confidence: 1.4 } } })).toEqual({
      decision: "consult",
      confidence: 1,
    });
    expect(parseLayaDecision({ answers: { route: { choice: "consult" } } })).toBeUndefined();
    expect(parseLayaDecision(null)).toBeUndefined();
  });
});

describe("jev config", () => {
  function parseWith(jev: unknown) {
    return configSchema.safeParse({ ...createDefaultConfig("jev"), jev });
  }

  it("accepts loopback endpoints and defaults to disabled", () => {
    const parsed = parseWith({ baseUrl: "http://localhost:8080/v1", model: "jev" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.jev).toMatchObject({
      enabled: false,
      protocol: "openai-chat",
      timeoutMs: 3_000,
      minConfidence: 0.8,
    });
    expect(parseWith({ baseUrl: "http://127.0.0.1:9932", model: "laya", protocol: "laya" }).success).toBe(true);
    expect(parseWith({ baseUrl: "http://127.0.0.1:9932", model: "x", protocol: "grpc" }).success).toBe(false);
    expect(parseWith({ baseUrl: "http://[::1]:8080/v1", model: "jev" }).success).toBe(true);
    expect(parseWith({ baseUrl: "http://127.0.0.2:8080/v1", model: "jev" }).success).toBe(true);
  });

  it("rejects remote hosts, unknown keys, and out-of-range thresholds", () => {
    expect(parseWith({ baseUrl: "https://api.example.com/v1", model: "jev" }).success).toBe(false);
    expect(parseWith({ baseUrl: "http://127.0.0.1.evil.com/v1", model: "jev" }).success).toBe(false);
    expect(parseWith({ baseUrl: "http://127.0.0.1/v1", model: "jev", apiKey: "secret" }).success).toBe(
      false,
    );
    expect(
      parseWith({ baseUrl: "http://127.0.0.1/v1", model: "jev", minConfidence: 0.2 }).success,
    ).toBe(false);
  });
});
