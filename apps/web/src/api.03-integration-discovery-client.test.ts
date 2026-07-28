import { afterEach, describe, expect, it, vi } from "vitest";

import {
  api,
  API_REQUEST_TIMEOUT_MS,
  INTEGRATION_DISCOVERY_REQUEST_TIMEOUT_MS,
} from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("integration discovery API client", () => {
  it("starts a server job and receives its result over SSE after the page request has ended", async () => {
    vi.useFakeTimers();
    class FakeEventSource {
      static latest: FakeEventSource | null = null;
      readonly listeners = new Map<string, EventListener>();
      onerror: ((event: Event) => void) | null = null;
      closed = false;

      constructor(readonly url: string, readonly options?: EventSourceInit) {
        FakeEventSource.latest = this;
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") this.listeners.set(type, listener);
      }

      close(): void {
        this.closed = true;
      }

      emit(type: string, data: unknown): void {
        this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const job = {
      id: "72d642ee-a2f4-40cb-8d68-5fd663454912",
      houseId: "house-main",
      status: "running" as const,
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
      expiresAt: "2026-07-28T10:10:00.000Z",
      result: null,
      error: null,
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ job }),
    } as Response);
    const onStarted = vi.fn();

    const discovery = api.discoverIntegrations(
      "house-main",
      { username: "person@example.com", password: "draft-secret" },
      onStarted,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(onStarted).toHaveBeenCalledWith(job);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/integrations/discovery-jobs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          houseId: "house-main",
          tpLinkUsername: "person@example.com",
          tpLinkPassword: "draft-secret",
        }),
      }),
    );
    expect(FakeEventSource.latest?.url).toBe(
      `/api/v1/integrations/discovery-jobs/events?jobId=${job.id}`,
    );
    expect(FakeEventSource.latest?.options).toEqual({ withCredentials: true });

    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    expect(FakeEventSource.latest?.closed).toBe(false);
    FakeEventSource.latest?.emit("integration-discovery", {
      ...job,
      status: "completed",
      result: { homeAssistant: [], tpLink: [], warnings: [] },
    });

    await expect(discovery).resolves.toEqual({
      homeAssistant: [],
      tpLink: [],
      warnings: [],
    });
    expect(FakeEventSource.latest?.closed).toBe(true);
    expect(INTEGRATION_DISCOVERY_REQUEST_TIMEOUT_MS).toBeGreaterThan(API_REQUEST_TIMEOUT_MS);
  });

  it("falls back to the owner-scoped job snapshot when SSE disconnects", async () => {
    class FakeEventSource {
      static latest: FakeEventSource | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly url: string) {
        FakeEventSource.latest = this;
      }

      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const job = {
      id: "72d642ee-a2f4-40cb-8d68-5fd663454912",
      houseId: "house-main",
      status: "running" as const,
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
      expiresAt: "2026-07-28T10:10:00.000Z",
      result: null,
      error: null,
    };
    const result = { homeAssistant: [], tpLink: [], warnings: ["No devices replied."] };
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ job }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ job: { ...job, status: "completed", result } }),
      } as Response);

    const discovery = api.discoverIntegrations("house-main");
    await vi.waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    FakeEventSource.latest?.onerror?.(new Event("error"));

    await expect(discovery).resolves.toEqual(result);
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/v1/integrations/discovery-jobs/${job.id}`,
      expect.any(Object),
    );
  });

  it("closes the browser subscription without cancelling the server job", async () => {
    class FakeEventSource {
      static latest: FakeEventSource | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;

      constructor() {
        FakeEventSource.latest = this;
      }

      addEventListener(): void {}
      close(): void {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const job = {
      id: "72d642ee-a2f4-40cb-8d68-5fd663454912",
      houseId: "house-main",
      status: "running" as const,
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
      expiresAt: "2026-07-28T11:00:00.000Z",
      result: null,
      error: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ job }),
    } as Response);
    const controller = new AbortController();

    const discovery = api.discoverIntegrations("house-main", undefined, undefined, controller.signal);
    await vi.waitFor(() => expect(FakeEventSource.latest).not.toBeNull());
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeEventSource.latest?.closed).toBe(true);
  });
});
