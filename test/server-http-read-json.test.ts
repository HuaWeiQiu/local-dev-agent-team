import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readJson } from "../src/server/http-common.js";

function request(chunks: Array<string | Buffer>): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (emitter as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  };
  return emitter;
}

describe("readJson", () => {
  it("parses a JSON body", async () => {
    await expect(readJson(request(['{"a":1}']))).resolves.toEqual({ a: 1 });
  });

  it("parses a body split across chunks", async () => {
    await expect(readJson(request(['{"a":', "2}"]))).resolves.toEqual({ a: 2 });
  });

  it("returns an empty object when the body is empty", async () => {
    await expect(readJson(request([]))).resolves.toEqual({});
  });

  it("accepts a Buffer chunk as-is", async () => {
    await expect(readJson(request([Buffer.from('{"b":3}')]))).resolves.toEqual({ b: 3 });
  });

  it("refuses a body over the limit with 413", async () => {
    await expect(readJson(request(["1234567890"]), 4)).rejects.toMatchObject({
      status: 413,
      code: "REQUEST_TOO_LARGE",
    });
  });

  it("refuses invalid JSON with 400", async () => {
    await expect(readJson(request(["{oops"]))).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
      message: "Request body must be valid JSON",
    });
  });
});
