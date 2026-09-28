import { afterEach, describe, expect, it, vi } from "vitest";
import { api, cancelPendingApiRequests, MAX_CONCURRENT_API_READ_REQUESTS, MAX_CONCURRENT_API_REQUESTS, requestFrom, COLLECTION_PAGE_SIZE } from "./api";

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => { cancelPendingApiRequests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("optional hydration scheduling", () => {
  it("loads visible electricity metrics and a mutation while optional hydration remains pending", async () => {
    const pending = new Map<string, (body: unknown) => void>();
    let active = 0;
    let reads = 0;
    let maximumActive = 0;
    let maximumReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const read = (init?.method ?? "GET") === "GET";
      active += 1;
      if (read) reads += 1;
      maximumActive = Math.max(maximumActive, active);
      maximumReads = Math.max(maximumReads, reads);
      return new Promise<Response>((resolve, reject) => {
        pending.set(url, (body) => resolve(response(body)));
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }).finally(() => { active -= 1; if (read) reads -= 1; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const requests: Promise<unknown>[] = [
      api.measurementSnapshot("home", "optional"),
      api.observations("home", "optional"),
      api.maintenanceTasks({ houseId: "home" }, "optional"),
      api.staticParameters("home", "optional"),
      api.measurementDefinitions("optional"),
      api.alertRules("optional"),
      api.alerts("optional"),
      api.scenarios("optional"),
      api.snapshot("other-home", "optional"),
      api.sensors("other-home", "optional"),
    ];
    let settled = Promise.allSettled(requests);
    try {
      const metric = api.houseEnergySummary("home", "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");
      requests.push(metric);
      settled = Promise.allSettled(requests);
      await vi.waitFor(() => expect([...pending.keys()].some((url) => url.includes("/energy-summary?"))).toBe(true), { timeout: 250 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect([...pending.keys()][0]).toContain("/measurements/snapshot?");
      const mutation = api.configurePropertyElectricity("property", { enabled: false } as Parameters<typeof api.configurePropertyElectricity>[1]);
      requests.push(mutation);
      settled = Promise.allSettled(requests);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect([...pending.keys()][2]).toContain("/electricity/config");
      expect(maximumActive).toBe(MAX_CONCURRENT_API_REQUESTS);
      expect(maximumReads).toBe(MAX_CONCURRENT_API_READ_REQUESTS);
      expect(fetchMock.mock.calls.every((call) => !("schedulingClass" in (call[1] ?? {})))).toBe(true);
      const metricUrl = [...pending.keys()].find((url) => url.includes("/energy-summary?"))!;
      pending.get(metricUrl)!({ summary: { consumptionKwh: 4 } });
      await expect(metric).resolves.toMatchObject({ consumptionKwh: 4 });
      const price = api.houseElectricityPrice("home");
      requests.push(price);
      settled = Promise.allSettled(requests);
      await vi.waitFor(() => expect([...pending.keys()].some((url) => url.endsWith("/electricity-price"))).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(maximumReads).toBe(MAX_CONCURRENT_API_READ_REQUESTS);
    } finally {
      cancelPendingApiRequests();
      await settled;
    }
  });
  it("preserves the optional slot through every maintenance collection page", async () => {
    const pending = new Map<string, (body: unknown) => void>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/electricity-price")) return Promise.resolve(response({ current: null }));
      return new Promise<Response>((resolve, reject) => {
        pending.set(url, (body) => resolve(response(body)));
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const maintenance = api.maintenanceTasks({ houseId: "home" }, "optional");
    const observations = api.observations("home", "optional");
    const settled = Promise.allSettled([maintenance, observations]);
    try {
      await vi.waitFor(() => expect(pending.size).toBe(1));
      pending.get("/api/v1/maintenance-tasks?houseId=home")!(Array.from({ length: COLLECTION_PAGE_SIZE }, (_, index) => ({ id: `task-${index}` })));
      await vi.waitFor(() => expect(pending.has("/api/v1/observations?houseId=home")).toBe(true));
      await Promise.resolve();
      expect([...pending.keys()].some((url) => url.includes("offset="))).toBe(false);
      await expect(api.houseElectricityPrice("home")).resolves.toEqual({ current: null });
      expect([...pending.keys()].some((url) => url.includes("offset="))).toBe(false);
      pending.get("/api/v1/observations?houseId=home")!([]);
      await observations;
      await vi.waitFor(() => expect([...pending.keys()].some((url) => url.includes("offset="))).toBe(true));
      pending.get([...pending.keys()].find((url) => url.includes("offset="))!)!([]);
      await expect(maintenance).resolves.toHaveLength(COLLECTION_PAGE_SIZE);
    } finally {
      cancelPendingApiRequests();
      await settled;
    }
  });

  it("releases optional capacity after queued/active cancellation and request failures", async () => {
    const active = new AbortController();
    const queued = new AbortController();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/active")) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
      if (url.endsWith("/http-error")) return Promise.resolve({ ...response({ error: { message: "Unavailable" } }), ok: false, status: 503 });
      if (url.endsWith("/network-error")) return Promise.reject(new Error("Network failed"));
      if (url.endsWith("/json-error")) return Promise.resolve({ ...response(null), json: async () => { throw new Error("Invalid JSON"); } });
      return Promise.resolve(response({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const requests = [
      requestFrom("/api/v1", "/active", { schedulingClass: "optional", signal: active.signal }),
      requestFrom("/api/v1", "/queued", { schedulingClass: "optional", signal: queued.signal }),
      ...["/http-error", "/network-error", "/json-error", "/success"].map((path) => requestFrom("/api/v1", path, { schedulingClass: "optional" })),
    ];
    const settled = Promise.allSettled(requests);
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      queued.abort();
      active.abort();
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected", "rejected", "fulfilled"]);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/api/v1/active", "/api/v1/http-error", "/api/v1/network-error", "/api/v1/json-error", "/api/v1/success",
      ]);
    } finally { cancelPendingApiRequests(); await settled; }
  });

});
