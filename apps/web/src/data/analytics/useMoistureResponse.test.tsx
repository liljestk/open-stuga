import { act, renderHook } from "@testing-library/react";
import { SYSTEM_VERSION, type DurableDerivedAnalyticsResponse, type MoistureResponseResult } from "@climate-twin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cached: vi.fn(), refresh: vi.fn() }));
vi.mock("../../api", () => ({ api: {
  cachedMoistureResponse: mocks.cached,
  refreshCachedMoistureResponse: mocks.refresh,
} }));

import { useMoistureResponse } from "./useMoistureResponse";

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}

function response(from: string, to: string): MoistureResponseResult {
  return {
    generatedAt: "2026-07-14T12:00:00.000Z",
    systemVersion: SYSTEM_VERSION,
    houseId: "house-a",
    from,
    to,
    entries: [],
    insights: [],
    methodology: {
      conversionMethod: "buck-vapor-pressure-v1",
      modelMethod: "first-order-moisture-response-v1",
      aggregationMethod: "median-child-metric-v1",
      interpretation: "Test",
      limitations: [],
    },
  };
}

function durable(result: MoistureResponseResult): DurableDerivedAnalyticsResponse<MoistureResponseResult> {
  return {
    apiVersion: "1.0", kind: "moisture-response", houseId: "house-a", dataMode: "live",
    windowDays: 7, cutoff: result.to, state: "ready", stale: false, result,
    artifact: { id: 1, generatedAt: result.generatedAt, cutoff: result.to, algorithmVersion: "v1", evidenceVersion: "e1" },
    job: null,
  };
}

describe("useMoistureResponse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps last-good evidence while a replacement is pending or fails", async () => {
    const first = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" };
    const pending = deferred<DurableDerivedAnalyticsResponse<MoistureResponseResult>>();
    mocks.cached.mockResolvedValueOnce(durable(response(first.from, first.to)));
    mocks.refresh.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useMoistureResponse("house-a", "live"));

    await act(async () => { await result.current.run({ windowDays: 7 }); });
    expect(result.current.result?.from).toBe(first.from);

    let replacement!: Promise<MoistureResponseResult | null>;
    await act(async () => { replacement = result.current.run({ windowDays: 14 }, true); });
    expect(result.current.result?.from).toBe(first.from);
    expect(result.current.loading).toBe(true);

    await act(async () => pending.reject(new Error("offline")));
    await replacement;
    expect(result.current.result?.from).toBe(first.from);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(true);
  });
});
