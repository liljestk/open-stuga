import { act, renderHook } from "@testing-library/react";
import { SYSTEM_VERSION, type MoistureResponseResult } from "@climate-twin/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ moistureResponse: vi.fn() }));
vi.mock("./api", () => ({ api: { moistureResponse: mocks.moistureResponse } }));

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

describe("useMoistureResponse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears an old evidence window while a replacement request is pending or fails", async () => {
    const first = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" };
    const second = { from: "2026-06-24T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z" };
    const pending = deferred<MoistureResponseResult>();
    mocks.moistureResponse
      .mockResolvedValueOnce(response(first.from, first.to))
      .mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useMoistureResponse("house-a"));

    await act(async () => { await result.current.run(first); });
    expect(result.current.result?.from).toBe(first.from);

    let replacement!: Promise<MoistureResponseResult | null>;
    await act(async () => { replacement = result.current.run(second); });
    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => pending.reject(new Error("offline")));
    await replacement;
    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(true);
  });
});
