import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  SPATIAL_LAYER_HISTORY_MIN_INTERVAL_MS,
  SPATIAL_LAYER_POLL_MS,
  useSpatialLayers,
} from "./useSpatialLayers";

afterEach(() => vi.restoreAllMocks());

function mockAvailableSpatialCapability() {
  const engines = vi.spyOn(api, "spatialLayerEngines").mockResolvedValue([{
    id: "test-engine",
    version: "1",
    maturity: "research",
    supportedScopes: ["house"],
    requiredMetrics: ["temperature"],
    layerIds: ["climate.scalar"],
    enabled: true,
    defaultEnabled: true,
  }]);
  const current = vi.spyOn(api, "houseSpatialLayersCurrent").mockResolvedValue({ snapshots: [], topology: null, health: [] });
  const health = vi.spyOn(api, "houseSpatialLayersHealth").mockResolvedValue([]);
  const configuration = vi.spyOn(api, "houseSpatialLayerConfig").mockResolvedValue({
    configuration: { version: 1, enabled: true, config: {} },
    assignments: [],
  });
  return { engines, current, health, configuration };
}

describe("useSpatialLayers optional capability", () => {
  it("keeps core views quiet when the local spatial host returns 503", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: "SPATIAL_LAYERS_UNAVAILABLE", message: "Research engine is not configured" } }),
    } as Response);

    const { result } = renderHook(() => useSpatialLayers({ scope: { kind: "house", id: "house-1" } }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.available).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.snapshots).toEqual([]);
  });

  it("does not start the specialist request fan-out until the view enables it", async () => {
    const requests = mockAvailableSpatialCapability();
    const view = renderHook(
      ({ enabled }) => useSpatialLayers({ scope: { kind: "house", id: "house-1" }, enabled }),
      { initialProps: { enabled: false } },
    );

    expect(requests.engines).not.toHaveBeenCalled();
    expect(requests.current).not.toHaveBeenCalled();
    expect(requests.health).not.toHaveBeenCalled();
    expect(requests.configuration).not.toHaveBeenCalled();

    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current.available).toBe(true));

    expect(requests.engines).toHaveBeenCalledOnce();
    expect(requests.current).toHaveBeenCalledOnce();
    expect(requests.health).not.toHaveBeenCalled();
    expect(requests.configuration).not.toHaveBeenCalled();
  });

  it("aborts both initial requests when the specialist gate closes", async () => {
    const requests = mockAvailableSpatialCapability();
    let engineSignal: AbortSignal | undefined;
    let currentSignal: AbortSignal | undefined;
    requests.engines.mockImplementationOnce((signal) => new Promise((resolve) => {
      engineSignal = signal;
      signal?.addEventListener("abort", () => resolve([]), { once: true });
    }));
    requests.current.mockImplementationOnce((_houseId, _layers, signal) => new Promise((resolve) => {
      currentSignal = signal;
      signal?.addEventListener("abort", () => resolve({ snapshots: [], topology: null, health: [] }), { once: true });
    }));
    const view = renderHook(
      ({ enabled }) => useSpatialLayers({ scope: { kind: "house", id: "house-1" }, enabled }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(engineSignal).toBeDefined();
      expect(currentSignal).toBeDefined();
    });
    view.rerender({ enabled: false });
    expect(engineSignal?.aborted).toBe(true);
    expect(currentSignal?.aborted).toBe(true);
    await waitFor(() => expect(view.result.current.loading).toBe(false));
  });

  it("skips background polling while hidden and refreshes immediately on return", async () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    const interval = vi.spyOn(window, "setInterval");
    const requests = mockAvailableSpatialCapability();
    const view = renderHook(() => useSpatialLayers({ scope: { kind: "house", id: "house-1" } }));
    try {
      await waitFor(() => expect(view.result.current.available).toBe(true));
      requests.current.mockClear();
      requests.health.mockClear();
      requests.configuration.mockClear();
      const poll = interval.mock.calls.find(([, delay]) => delay === SPATIAL_LAYER_POLL_MS)?.[0];
      expect(typeof poll).toBe("function");

      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      act(() => { if (typeof poll === "function") poll(); });
      expect(requests.current).not.toHaveBeenCalled();

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(requests.current).toHaveBeenCalledOnce());
      expect(requests.health).not.toHaveBeenCalled();
      expect(requests.configuration).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
    }
  });

  it("aborts an obsolete refresh before starting the next one", async () => {
    const requests = mockAvailableSpatialCapability();
    const view = renderHook(() => useSpatialLayers({ scope: { kind: "house", id: "house-1" } }));
    await waitFor(() => expect(view.result.current.available).toBe(true));

    let firstSignal: AbortSignal | undefined;
    requests.current.mockImplementationOnce((_houseId, _layers, signal) => new Promise((resolve) => {
      firstSignal = signal;
      signal?.addEventListener("abort", () => resolve({ snapshots: [], topology: null, health: [] }), { once: true });
    }));

    let firstRefresh!: Promise<void>;
    act(() => { firstRefresh = view.result.current.refresh(); });
    await waitFor(() => expect(firstSignal).toBeDefined());
    await act(async () => { await view.result.current.refresh(); });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => { await firstRefresh; });
  });

  it("bounds replay archive reads and catches up to the latest cursor", async () => {
    mockAvailableSpatialCapability();
    const history = vi.spyOn(api, "houseSpatialLayersHistory").mockResolvedValue([]);
    const timeout = vi.spyOn(window, "setTimeout");
    const view = renderHook(
      ({ historyAt }) => useSpatialLayers({
        scope: { kind: "house", id: "house-1" },
        historyAt,
      }),
      { initialProps: { historyAt: Date.parse("2026-08-08T09:00:00.000Z") } },
    );

    await waitFor(() => expect(history).toHaveBeenCalledOnce());
    for (let frame = 1; frame <= 20; frame += 1) {
      view.rerender({ historyAt: Date.parse("2026-08-08T09:00:00.000Z") + frame * 250 });
    }
    expect(history).toHaveBeenCalledOnce();

    const trailingCommit = timeout.mock.calls.find(([, delay]) => (
      typeof delay === "number" && delay > SPATIAL_LAYER_HISTORY_MIN_INTERVAL_MS - 1_000
    ))?.[0];
    expect(typeof trailingCommit).toBe("function");
    await act(async () => {
      if (typeof trailingCommit === "function") trailingCommit();
      await Promise.resolve();
    });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(history.mock.calls[1]?.[1].to).toBe("2026-08-08T09:01:05.000Z");
    view.unmount();
  });

  it("prefetches a known replay range once and filters cursor movement locally", async () => {
    mockAvailableSpatialCapability();
    const history = vi.spyOn(api, "houseSpatialLayersHistory").mockResolvedValue([]);
    const from = Date.parse("2026-08-08T00:00:00.000Z");
    const to = Date.parse("2026-08-09T00:00:00.000Z");
    const view = renderHook(
      ({ historyAt, rangeTo }) => useSpatialLayers({
        scope: { kind: "house", id: "house-1" },
        historyAt,
        historyRange: { from, to: rangeTo },
      }),
      { initialProps: { historyAt: from, rangeTo: to } },
    );

    await waitFor(() => expect(history).toHaveBeenCalledOnce());
    expect(history).toHaveBeenCalledWith("house-1", {
      layerIds: ["climate.scalar"],
      from: "2026-08-08T00:00:00.000Z",
      to: "2026-08-09T00:00:00.000Z",
      limit: 20_000,
    }, expect.any(AbortSignal));

    for (let frame = 1; frame <= 20; frame += 1) {
      view.rerender({ historyAt: from + frame * 60_000, rangeTo: to });
    }
    expect(history).toHaveBeenCalledOnce();

    view.rerender({ historyAt: from, rangeTo: to + 60_000 });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    view.unmount();
  });
});
