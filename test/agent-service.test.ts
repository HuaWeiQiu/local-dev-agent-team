import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearPromptTemplateCache,
  loadPromptTemplate,
  StreamEventBatcher,
} from "../src/agents/service.js";

describe("StreamEventBatcher", () => {
  it("coalesces rapid chunks into few events without losing content", () => {
    let now = 1_000_000;
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const batcher = new StreamEventBatcher({
      now: () => now,
      emit: (stream, chunk) => emitted.push({ stream, chunk }),
    });
    const chunks: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const chunk = `chunk-${index}\n`;
      chunks.push(chunk);
      batcher.push("stdout", chunk);
      now += 1;
    }
    expect(emitted).toEqual([]);

    batcher.flushAll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ stream: "stdout", chunk: chunks.join("") });
  });

  it("flushes a stream once its buffer passes the time window", () => {
    let now = 1_000_000;
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const batcher = new StreamEventBatcher({
      now: () => now,
      emit: (stream, chunk) => emitted.push({ stream, chunk }),
    });
    batcher.push("stdout", "first");
    now += 250;
    batcher.push("stdout", "second");
    expect(emitted).toEqual([{ stream: "stdout", chunk: "first" }]);

    batcher.push("stderr", "error");
    batcher.flushAll();
    expect(emitted).toEqual([
      { stream: "stdout", chunk: "first" },
      { stream: "stdout", chunk: "second" },
      { stream: "stderr", chunk: "error" },
    ]);
  });

  it("flushes a stream once its buffer passes the size threshold", () => {
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const batcher = new StreamEventBatcher({
      now: () => 1_000_000,
      maxBufferedCharacters: 1_024,
      emit: (stream, chunk) => emitted.push({ stream, chunk }),
    });
    batcher.push("stderr", "x".repeat(700));
    expect(emitted).toEqual([]);
    batcher.push("stderr", "y".repeat(700));
    expect(emitted).toEqual([
      { stream: "stderr", chunk: `${"x".repeat(700)}${"y".repeat(700)}` },
    ]);
  });
});

describe("prompt template cache", () => {
  it("reads a prompt template from disk only once per path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-prompts-"));
    const promptPath = path.join(root, "worker.md");
    await writeFile(promptPath, "You are a worker.\n", "utf8");

    clearPromptTemplateCache();
    await expect(loadPromptTemplate(promptPath)).resolves.toBe("You are a worker.\n");
    await rm(promptPath);
    // Second render is served from the process-level cache.
    await expect(loadPromptTemplate(promptPath)).resolves.toBe("You are a worker.\n");

    clearPromptTemplateCache();
    await expect(loadPromptTemplate(promptPath)).rejects.toThrow();
  });

  it("does not cache failed reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-team-prompts-"));
    const promptPath = path.join(root, "reviewer.md");

    clearPromptTemplateCache();
    await expect(loadPromptTemplate(promptPath)).rejects.toThrow();
    await writeFile(promptPath, "You are a reviewer.\n", "utf8");
    await expect(loadPromptTemplate(promptPath)).resolves.toBe("You are a reviewer.\n");
  });
});
