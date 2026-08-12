import { describe, expect, it } from "vitest";
import {
  classificationForCode,
  classifyProviderFailure,
  ProviderHealthRegistry,
  RoleProfileChainError,
} from "../src/providers/failure.js";

describe("classifyProviderFailure", () => {
  it("classifies quota exhaustion", () => {
    const result = classifyProviderFailure({
      message: "Error: You exceeded your current quota",
      exitCode: 1,
    });
    expect(result.code).toBe("MODEL_QUOTA_EXHAUSTED");
    expect(result.infrastructure).toBe(true);
    expect(result.pauseEvolution).toBe(true);
  });

  it("classifies rate limits", () => {
    const result = classifyProviderFailure({
      stderr: "HTTP 429 too many requests; retry-after: 30",
      exitCode: 1,
    });
    expect(result.code).toBe("MODEL_RATE_LIMITED");
    expect(result.infrastructure).toBe(true);
    expect(result.pauseEvolution).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("classifies authentication failures", () => {
    const result = classifyProviderFailure({
      message: "unauthorized: invalid api key",
      exitCode: 1,
    });
    expect(result.code).toBe("MODEL_AUTH_FAILED");
    expect(result.pauseEvolution).toBe(true);
    expect(result.retryable).toBe(false);
  });

  it("classifies network errors from errno", () => {
    const result = classifyProviderFailure({
      message: "request failed",
      errno: "ECONNRESET",
    });
    expect(result.code).toBe("MODEL_NETWORK_ERROR");
    expect(result.pauseEvolution).toBe(true);
  });

  it("classifies missing models", () => {
    const result = classifyProviderFailure({
      stderr: "model_not_found: gpt-missing is not available",
      exitCode: 1,
    });
    expect(result.code).toBe("MODEL_NOT_FOUND");
  });

  it("classifies process and output failures", () => {
    expect(
      classifyProviderFailure({ message: "spawn agent-team-missing ENOENT", errno: "ENOENT" })
        .code,
    ).toBe("MODEL_PROCESS_ERROR");
    expect(
      classifyProviderFailure({ message: "codex output could not be parsed: Unexpected token" })
        .code,
    ).toBe("MODEL_OUTPUT_INVALID");
  });

  it("prefers quota over generic 429 when both appear", () => {
    const result = classifyProviderFailure({
      message: "429: exceeded your current quota for the project",
    });
    expect(result.code).toBe("MODEL_QUOTA_EXHAUSTED");
  });
});

describe("ProviderHealthRegistry", () => {
  it("opens a circuit after a failure and allows a recovery probe later", () => {
    let now = 1_000;
    const health = new ProviderHealthRegistry(() => now);
    const classification = classificationForCode("MODEL_RATE_LIMITED");

    health.recordFailure("worker", "codex", "gpt", classification);
    const blocked = health.allowAttempt("worker", "codex", "gpt");
    expect(blocked.allowed).toBe(false);
    expect(blocked.snapshot.state).toBe("open");

    now += classification.backoffMs + 1;
    const probe = health.allowAttempt("worker", "codex", "gpt");
    expect(probe.allowed).toBe(true);
    expect(probe.snapshot.state).toBe("half-open");
    expect(probe.reason).toBe("recovery-probe");

    health.recordSuccess("worker", "codex", "gpt");
    expect(health.allowAttempt("worker", "codex", "gpt").snapshot.state).toBe("closed");
  });

  it("does not open a circuit for zero-backoff output errors", () => {
    const health = new ProviderHealthRegistry();
    health.recordFailure(
      "reviewer",
      "codex",
      "gpt",
      classificationForCode("MODEL_OUTPUT_INVALID"),
    );
    expect(health.allowAttempt("reviewer", "codex", "gpt").allowed).toBe(true);
    expect(health.get("reviewer", "codex", "gpt")?.state).toBe("closed");
  });
});

describe("RoleProfileChainError", () => {
  it("aggregates attempt codes and infrastructure flags", () => {
    const error = new RoleProfileChainError("worker", [
      {
        profile: "primary",
        adapter: "codex",
        model: "a",
        classification: classificationForCode("MODEL_QUOTA_EXHAUSTED"),
        message: "quota",
        at: "2026-08-12T00:00:00.000Z",
      },
      {
        profile: "fallback",
        adapter: "grok",
        model: "b",
        classification: classificationForCode("MODEL_PROCESS_ERROR"),
        message: "spawn failed",
        at: "2026-08-12T00:00:01.000Z",
      },
    ]);
    expect(error.codes).toEqual(["MODEL_QUOTA_EXHAUSTED", "MODEL_PROCESS_ERROR"]);
    expect(error.infrastructure).toBe(true);
    expect(error.pauseEvolution).toBe(true);
    expect(error.message).toContain("[MODEL_QUOTA_EXHAUSTED]");
  });
});
