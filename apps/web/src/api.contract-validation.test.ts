import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseShapeError } from "@climate-twin/contracts";
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

    const failure = api.properties();
    await expect(failure).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(failure).rejects.toThrow("Unexpected response shape from properties (expected an array)");
  });

  it("rejects malformed collection items instead of treating them as resources", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ properties: ["not-a-property"] }),
    } as Response);

    const failure = api.properties();
    await expect(failure).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(failure).rejects.toThrow("Unexpected response shape from properties (contains a non-object item)");
  });
});
