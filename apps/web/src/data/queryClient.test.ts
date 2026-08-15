import { describe, expect, it } from "vitest";

import { ApiRequestError } from "../api";
import { shouldRetryServerQuery } from "./queryClient";

describe("server query retry policy", () => {
  it("does not amplify timeouts, cancellations, or client errors", () => {
    expect(shouldRetryServerQuery(0, new DOMException("slow", "TimeoutError"))).toBe(false);
    expect(shouldRetryServerQuery(0, new DOMException("gone", "AbortError"))).toBe(false);
    expect(shouldRetryServerQuery(0, new ApiRequestError(404, "NOT_FOUND", "missing"))).toBe(false);
  });

  it("retries one transient server failure only", () => {
    const failure = new ApiRequestError(503, "UNAVAILABLE", "later");
    expect(shouldRetryServerQuery(0, failure)).toBe(true);
    expect(shouldRetryServerQuery(1, failure)).toBe(false);
  });
});
