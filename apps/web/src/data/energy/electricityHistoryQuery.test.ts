import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsQueryResponse } from "@climate-twin/contracts";
import { api } from "../../api";
import { electricityHistoryQueryOptions } from "./electricityHistoryQuery";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("consumption history queries", () => {
  it("uses bounded server integrals for every range and works on LAN HTTP", async () => {
    vi.stubGlobal("crypto", {});
    const query = vi.spyOn(api, "analyticsQuery").mockResolvedValue({ series: [] } as unknown as AnalyticsQueryResponse);
    const sources = Array.from({ length: 30 }, (_, index) => ({ id: `meter-${index}`, energy: true, power: true }));
    const signal = new AbortController().signal;
    const options = electricityHistoryQueryOptions("home", sources, "1y", "UTC", "live", true);
    await options.queryFn({ signal });
    expect(query).toHaveBeenCalledTimes(4);
    for (const [input, passedSignal] of query.mock.calls) {
      expect(input.resolution).toBe("1d");
      expect(input.maxPointsPerSeries).toBe(400);
      expect(input.scope.entityIds!.length).toBeLessThanOrEqual(24);
      expect(input.aggregation).toBe(input.measurementIds[0] === "energy" ? "delta" : "time_weighted_mean");
      expect(input.requestId).toMatch(/^electricity-/);
      expect(passedSignal).toBe(signal);
    }
    expect(options.refetchInterval).toBe(300_000);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("does not continue batches after cancellation and gives selections distinct cache keys", async () => {
    const controller = new AbortController();
    const sources = Array.from({ length: 30 }, (_, index) => ({ id: `meter-${index}`, energy: true, power: false }));
    const query = vi.spyOn(api, "analyticsQuery").mockImplementation(async () => {
      controller.abort();
      return { series: [] } as unknown as AnalyticsQueryResponse;
    });
    const options = electricityHistoryQueryOptions("home", sources, "24h", "UTC", "live", true);
    await expect(options.queryFn({ signal: controller.signal })).rejects.toBeDefined();
    expect(query).toHaveBeenCalledOnce();
    expect(options.queryKey).not.toEqual(electricityHistoryQueryOptions("home", sources.slice(1), "24h", "UTC", "live", true).queryKey);
  });
});
