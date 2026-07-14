import { describe, expect, it } from "vitest";
import { readJson } from "../src/http.js";

function streamedRequest(parts: string[]): Request {
  const encoder = new TextEncoder();
  return {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
  } as Request;
}

describe("bounded JSON bodies", () => {
  it("parses a chunked body below the byte limit", async () => {
    await expect(readJson(streamedRequest(["{\"ok\":", "true}"]), 20)).resolves.toEqual({ ok: true });
  });

  it("cancels a chunked body as soon as its raw bytes exceed the limit", async () => {
    await expect(readJson(streamedRequest(["{\"value\":\"", "too-large\"}"]), 12)).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});
