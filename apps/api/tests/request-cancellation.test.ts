import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApi } from "../src/app.js";
import { config } from "./appTestSupport.js";

const DRAFT = { url: "http://homeassistant.local:8123", token: "home-assistant-draft-token" };

describe("cancelled requests", () => {
  it("answers a cancelled request without reporting a server fault", async () => {
    const runtime = createApi({
      config,
      startBackground: false,
      homeAssistantCredentialTester: () => Promise.reject(new DOMException("Cache entry invalidated", "AbortError")),
    });
    try {
      await request(runtime.app).post("/api/v1/integrations/home-assistant/test-draft")
        .send(DRAFT)
        .expect(503)
        .expect("retry-after", "1")
        .expect(({ body }) => {
          expect(body.error.code).toBe("REQUEST_CANCELLED");
        });
      expect(runtime.systemErrorLog.list().filter((entry) => entry.source === "api")).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("still reports and logs a genuine failure", async () => {
    const runtime = createApi({
      config,
      startBackground: false,
      homeAssistantCredentialTester: () => Promise.reject(new Error("credential probe exploded")),
    });
    try {
      await request(runtime.app).post("/api/v1/integrations/home-assistant/test-draft")
        .send(DRAFT)
        .expect(500)
        .expect(({ body }) => {
          expect(body.error.code).toBe("INTERNAL_ERROR");
        });
      expect(runtime.systemErrorLog.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "api", code: "Error", message: "credential probe exploded" }),
      ]));
    } finally {
      await runtime.close();
    }
  });
});
