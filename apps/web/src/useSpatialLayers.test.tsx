import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { SPATIAL_LAYER_POLL_MS, useSpatialLayers } from "./useSpatialLayers";

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
  const current = vi.spyOn(api, "houseSpatialLayersCurrent").mockResolvedValue([]);
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
    expect(requests.health).toHaveBeenCalledOnce();
    expect(requests.configuration).toHaveBeenCalledOnce();
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
      expect(requests.health).toHaveBeenCalledOnce();
      expect(requests.configuration).toHaveBeenCalledOnce();
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
      signal?.addEventListener("abort", () => resolve([]), { once: true });
    }));

    let firstRefresh!: Promise<void>;
    act(() => { firstRefresh = view.result.current.refresh(); });
    await waitFor(() => expect(firstSignal).toBeDefined());
    await act(async () => { await view.result.current.refresh(); });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => { await firstRefresh; });
  });
});
