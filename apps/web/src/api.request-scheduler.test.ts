import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelPendingApiRequests,
  MAX_CONCURRENT_API_READ_REQUESTS,
  MAX_CONCURRENT_API_REQUESTS,
  requestFrom,
} from "./api";

type DeferredResponse = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};

function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  cancelPendingApiRequests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API request scheduling", () => {
  it("bounds fetch fan-out and starts the next read after a slot is released", async () => {
    const deferred = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS + 1 }, deferredResponse);
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      const current = deferred[fetchMock.mock.calls.length - 1]!;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return current.promise.finally(() => { active -= 1; });
    });
    vi.stubGlobal("fetch", fetchMock);

    const requests = deferred.map((_, index) => requestFrom(
      "/api/v1",
      `/scheduler-test/${index}`,
    ));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS));
    expect(maximumActive).toBe(MAX_CONCURRENT_API_READ_REQUESTS);

    deferred[0]!.resolve(response({ index: 0 }));
    await expect(requests[0]).resolves.toEqual({ index: 0 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS + 1));

    for (let index = 1; index < deferred.length; index += 1) {
      deferred[index]!.resolve(response({ index }));
    }
    await expect(Promise.all(requests.slice(1))).resolves.toHaveLength(MAX_CONCURRENT_API_READ_REQUESTS);
    expect(maximumActive).toBe(MAX_CONCURRENT_API_READ_REQUESTS);
  });

  it("reserves capacity for mutations while history reads are active", async () => {
    const deferred = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS + 2 }, deferredResponse);
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => (
      deferred[fetchMock.mock.calls.length - 1]!.promise
    ));
    vi.stubGlobal("fetch", fetchMock);
    const reads = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS + 1 }, (_, index) => (
      requestFrom("/api/v1", `/history/${index}`)
    ));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS));

    const mutation = requestFrom("/api/v1", "/settings", { method: "POST" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_REQUESTS));
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST" });
    deferred[MAX_CONCURRENT_API_READ_REQUESTS]!.resolve(response({ saved: true }));
    await expect(mutation).resolves.toEqual({ saved: true });
    for (let index = 0; index < MAX_CONCURRENT_API_READ_REQUESTS; index += 1) {
      deferred[index]!.resolve(response({ index }));
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS + 2));
    deferred.at(-1)!.resolve(response({ index: MAX_CONCURRENT_API_READ_REQUESTS }));
    await expect(Promise.all(reads)).resolves.toHaveLength(MAX_CONCURRENT_API_READ_REQUESTS + 1);
  });

  it("reserves capacity for a session check while history reads are active", async () => {
    const deferred = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS + 2 }, deferredResponse);
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => (
      deferred[fetchMock.mock.calls.length - 1]!.promise
    ));
    vi.stubGlobal("fetch", fetchMock);
    const reads = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS + 1 }, (_, index) => (
      requestFrom("/api/v1", `/history/session-${index}`)
    ));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS));

    const session = requestFrom("/api/v1", "/session");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_REQUESTS));
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/session");
    deferred[MAX_CONCURRENT_API_READ_REQUESTS]!.resolve(response({ authenticated: true }));
    await expect(session).resolves.toEqual({ authenticated: true });
    for (let index = 0; index < MAX_CONCURRENT_API_READ_REQUESTS; index += 1) {
      deferred[index]!.resolve(response({ index }));
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS + 2));
    deferred.at(-1)!.resolve(response({ index: MAX_CONCURRENT_API_READ_REQUESTS }));
    await expect(Promise.all(reads)).resolves.toHaveLength(MAX_CONCURRENT_API_READ_REQUESTS + 1);
  });

  it.each([
    ["a true mutation", "/settings", { method: "POST" }],
    ["a session check", "/session", undefined],
  ] as const)("keeps the reserved slot available for %s during analytics POSTs", async (
    _label,
    interactivePath,
    interactiveOptions,
  ) => {
    const deferred = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS + 2 }, deferredResponse);
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => (
      deferred[fetchMock.mock.calls.length - 1]!.promise
    ));
    vi.stubGlobal("fetch", fetchMock);

    const analytics = ["/analytics/query", "/analytics/coverage", "/analytics/calendar-comparison"]
      .map((path) => requestFrom("/api/v2", path, {
        method: "POST",
        schedulingClass: "background",
        body: "{}",
      }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS));

    const interactive = requestFrom(
      "/api/v1",
      interactivePath,
      interactiveOptions,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_REQUESTS));
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`/api/v1${interactivePath}`);
    expect(fetchMock.mock.calls.slice(0, MAX_CONCURRENT_API_READ_REQUESTS).every((call) => (
      !("schedulingClass" in (call[1] ?? {}))
    ))).toBe(true);

    deferred[MAX_CONCURRENT_API_READ_REQUESTS]!.resolve(response({ interactive: true }));
    await expect(interactive).resolves.toEqual({ interactive: true });
    deferred[0]!.resolve(response({ path: "running" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_REQUESTS + 1));
    deferred.at(-1)!.resolve(response({ path: "queued" }));
    for (let index = 1; index < MAX_CONCURRENT_API_READ_REQUESTS; index += 1) {
      deferred[index]!.resolve(response({ path: "running" }));
    }
    await expect(Promise.all(analytics)).resolves.toHaveLength(3);
  });

  it("does not spend a request timeout while the call is waiting for capacity", async () => {
    const deferred = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS + 1 }, deferredResponse);
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => (
      deferred[fetchMock.mock.calls.length - 1]!.promise
    ));
    vi.stubGlobal("fetch", fetchMock);

    const running = Array.from({ length: MAX_CONCURRENT_API_READ_REQUESTS }, (_, index) => (
      requestFrom("/api/v1", `/queue-timeout/${index}`, { timeoutMs: 1_000 })
    ));
    const queued = requestFrom(
      "/api/v1",
      "/queue-timeout/queued",
      { timeoutMs: 10 },
    );
    const queuedOutcome = queued.then(() => "resolved", (error: unknown) => (
      error instanceof Error ? error.name : "rejected"
    ));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS));
    const beforeRelease = await Promise.race([
      queuedOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 30)),
    ]);
    expect(beforeRelease).toBe("pending");

    deferred[0]!.resolve(response({ index: 0 }));
    await expect(running[0]).resolves.toEqual({ index: 0 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(MAX_CONCURRENT_API_READ_REQUESTS + 1));
    deferred.at(-1)!.resolve(response({ index: 2 }));
    await expect(queued).resolves.toEqual({ index: 2 });

    for (let index = 1; index < MAX_CONCURRENT_API_READ_REQUESTS; index += 1) {
      deferred[index]!.resolve(response({ index }));
    }
    await expect(Promise.all(running)).resolves.toHaveLength(MAX_CONCURRENT_API_READ_REQUESTS);
  });
});
