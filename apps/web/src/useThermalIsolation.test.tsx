import { act, renderHook } from "@testing-library/react";
import { SYSTEM_VERSION, type ThermalIsolationResult } from "@climate-twin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ thermalIsolation: vi.fn() }));
vi.mock("./api", () => ({ api: { thermalIsolation: mocks.thermalIsolation } }));

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

describe("useThermalIsolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears an old window while a new request is pending and after it fails", async () => {
    const firstOptions = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" };
    const secondOptions = { from: "2026-06-24T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" };
    const second = deferred<ThermalIsolationResult>();
    mocks.thermalIsolation
      .mockResolvedValueOnce(isolation(firstOptions.from, firstOptions.to))
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useThermalIsolation("house-a"));

    await act(async () => { await result.current.run(firstOptions); });
    expect(result.current.result?.from).toBe(firstOptions.from);

    let secondRun!: Promise<ThermalIsolationResult | null>;
    await act(async () => { secondRun = result.current.run(secondOptions); });
    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => second.reject(new Error("network unavailable")));
    await secondRun;
    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(true);
  });
});
