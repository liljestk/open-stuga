import { act, renderHook } from "@testing-library/react";
import { SYSTEM_VERSION, type DurableDerivedAnalyticsResponse, type ThermalIsolationResult } from "@climate-twin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cached: vi.fn(), refresh: vi.fn() }));
vi.mock("../../api", () => ({ api: {
  cachedThermalIsolation: mocks.cached,
  refreshCachedThermalIsolation: mocks.refresh,
} }));

import { useThermalIsolation } from "./useThermalIsolation";

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}

function isolation(from: string, to: string): ThermalIsolationResult {
  return {
    generatedAt: "2026-07-14T12:00:00.000Z",
    systemVersion: SYSTEM_VERSION,
    houseId: "house-a",
    from,
    to,
    entries: [],
    insights: [],
    methodology: {
      scoreMethod: "modeled-24h-retention-v1",
      aggregationMethod: "median-child-score-v1",
      interpretation: "Test",
      limitations: [],
    },
  };
}

function durable(result: ThermalIsolationResult): DurableDerivedAnalyticsResponse<ThermalIsolationResult> {
  return {
    apiVersion: "1.0", kind: "thermal-isolation", houseId: "house-a", dataMode: "live",
    windowDays: 7, cutoff: result.to, state: "ready", stale: false, result,
    artifact: { id: 1, generatedAt: result.generatedAt, cutoff: result.to, algorithmVersion: "v1", evidenceVersion: "e1" },
    job: null,
  };
}

describe("useThermalIsolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps last-good evidence while a manual refresh is pending or fails", async () => {
    const firstOptions = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" };
    const second = deferred<DurableDerivedAnalyticsResponse<ThermalIsolationResult>>();
    mocks.cached.mockResolvedValueOnce(durable(isolation(firstOptions.from, firstOptions.to)));
    mocks.refresh.mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useThermalIsolation("house-a", "live"));

    await act(async () => { await result.current.run({ windowDays: 7 }); });
    expect(result.current.result?.from).toBe(firstOptions.from);

    let secondRun!: Promise<ThermalIsolationResult | null>;
    await act(async () => { secondRun = result.current.run({ windowDays: 14 }, true); });
    expect(result.current.result?.from).toBe(firstOptions.from);
    expect(result.current.loading).toBe(true);

    await act(async () => second.reject(new Error("network unavailable")));
    await secondRun;
    expect(result.current.result?.from).toBe(firstOptions.from);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(true);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.errorStatus).toBeNull();
    expect(result.current.errorDetail).toBe("network unavailable");
  });

  it("preserves API error details for an accurate recovery message", async () => {
    mocks.cached.mockRejectedValueOnce({
      status: 422,
      code: "THERMAL_SCOPE_TOO_LARGE",
      message: "Too many sensors",
    });
    const { result } = renderHook(() => useThermalIsolation("house-a", "live"));

    await act(async () => {
      await result.current.run({ windowDays: 7 });
    });

    expect(result.current.error).toBe(true);
    expect(result.current.errorCode).toBe("THERMAL_SCOPE_TOO_LARGE");
    expect(result.current.errorStatus).toBe(422);
    expect(result.current.errorDetail).toBe("Too many sensors");
  });

  it("does not poll an idle durable artifact", async () => {
    vi.useFakeTimers();
    mocks.cached.mockResolvedValue({
      apiVersion: "1.0",
      kind: "thermal-isolation",
      houseId: "house-a",
      dataMode: "live",
      windowDays: 7,
      cutoff: "2026-08-08T00:00:00.000Z",
      state: "idle",
      stale: false,
      result: null,
      artifact: null,
      job: null,
    } satisfies DurableDerivedAnalyticsResponse<ThermalIsolationResult>);
    try {
      const { result } = renderHook(() => useThermalIsolation("house-a", "live"));
      await act(async () => { await result.current.run({ windowDays: 7 }); });
      expect(result.current.status?.state).toBe("idle");
      expect(mocks.cached).toHaveBeenCalledOnce();

      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(mocks.cached).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
