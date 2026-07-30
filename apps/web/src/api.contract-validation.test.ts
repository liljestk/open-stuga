import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import "./apiTestSupport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API response contract validation", () => {
  it("fails closed when a successful collection response has the wrong shape", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: [] }),
    } as Response);

    await expect(api.properties()).rejects.toThrow(
      "Invalid API response: expected an array in properties, data",
    );
  });

  it("rejects malformed collection items instead of treating them as resources", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ properties: ["not-a-property"] }),
    } as Response);

    await expect(api.properties()).rejects.toThrow(
      "Invalid API response: properties contains a non-object item",
    );
  });
});
