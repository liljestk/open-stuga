import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode, type PropsWithChildren } from "react";
import type { AnalyticsQueryResponse, EnergyOptimizationReport } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { useElectricityHistoryQuery } from "./electricityHistoryQuery";
import { useEnergyOptimizationQuery, usePriceHistoryQuery, usePropertyElectricityQuery } from "./electricityQueries";
import { useHouseElectricityPriceQuery } from "./houseElectricityPriceQuery";
import { useHomeEnergySummaryQuery } from "./homeEnergySummaryQuery";

afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

const sources = [{ id: "meter", energy: true, power: false }];
const hooks = [
  ["cost summary", (enabled: boolean) => useHomeEnergySummaryQuery("home", "year", 365 * 86_400_000, enabled, 900_000)],
  ["consumption", (enabled: boolean) => useElectricityHistoryQuery("home", sources, "1y", "UTC", "live", enabled)],
  ["price history", (enabled: boolean) => usePriceHistoryQuery("home", "24h", enabled)],
  ["optimization", (enabled: boolean) => useEnergyOptimizationQuery("property", enabled)],
  ["property price", (enabled: boolean) => usePropertyElectricityQuery("property", enabled)],
  ["home price", (enabled: boolean) => useHouseElectricityPriceQuery("home", enabled)],
] as const;

function pendingRequests(): AbortSignal[] {
  const signals: AbortSignal[] = [];
  const pending = <T>(signal?: AbortSignal): Promise<T> => {
    if (signal) signals.push(signal);
    return new Promise<T>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  vi.spyOn(api, "analyticsQuery").mockImplementation((_input, signal) => pending(signal));
  vi.spyOn(api, "houseElectricityPrice").mockImplementation((_id, _from, _to, signal) => pending(signal));
  vi.spyOn(api, "houseEnergySummary").mockImplementation((_id, _from, _to, signal) => pending(signal));
  vi.spyOn(api, "propertyElectricity").mockImplementation((_id, signal) => pending(signal));
  vi.spyOn(api, "energyOptimization").mockImplementation((_id, _hours, signal) => pending(signal));
  return signals;
}

describe("electricity query cancellation", () => {
  it.each(hooks)("aborts %s when its same-key observer becomes disabled", async (_name, useHook) => {
    const signals = pendingRequests();
    const view = renderHook(({ enabled }) => useHook(enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(signals).toHaveLength(1));
    view.rerender({ enabled: false });
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });

  it("keeps a shared request running until its last enabled observer is disabled", async () => {
    const signals = pendingRequests();
    const view = renderHook(({ first, second }) => {
      useEnergyOptimizationQuery("property", first);
      useEnergyOptimizationQuery("property", second);
    }, { initialProps: { first: true, second: true } });
    await waitFor(() => expect(signals).toHaveLength(1));
    view.rerender({ first: false, second: true });
    expect(signals[0]!.aborted).toBe(false);
    view.rerender({ first: false, second: false });
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });

  it.each([false, true])("keeps shared ownership swaps stable (Strict Mode: %s)", async (strict) => {
    const signals = pendingRequests();
    const view = renderHook(({ first, second }) => {
      useEnergyOptimizationQuery("property", first);
      useEnergyOptimizationQuery("property", second);
    }, { initialProps: { first: true, second: false },
      ...(strict ? { wrapper: ({ children }: PropsWithChildren) => createElement(StrictMode, null, children) } : {}),
    });
    await waitFor(() => expect(signals.at(-1)?.aborted).toBe(false));
    const requestCount = signals.length;
    view.rerender({ first: false, second: true });
    await act(async () => { await Promise.resolve(); });
    expect(signals).toHaveLength(requestCount);
    expect(signals.at(-1)!.aborted).toBe(false);
  });

  it("cancels when the enabled owner unmounts but a disabled observer remains", async () => {
    const signals = pendingRequests();
    const owner = renderHook(() => useEnergyOptimizationQuery("property", true));
    renderHook(() => useEnergyOptimizationQuery("property", false));
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    owner.unmount();
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });

  it("retains the cached result when a refresh is cancelled", async () => {
    const signals = pendingRequests();
    const key = ["property", "property", "energy-optimization", 2];
    const cached = { generatedAt: "2026-09-01T00:00:00Z" } as EnergyOptimizationReport;
    queryClient.setQueryData(key, cached, { updatedAt: Date.now() - 600_000 });
    const view = renderHook(({ enabled }) => useEnergyOptimizationQuery("property", enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(signals).toHaveLength(1));
    view.rerender({ enabled: false });
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
    expect(queryClient.getQueryData(key)).toEqual(cached);
    expect(view.result.current.data).toEqual(cached);
  });

  it("does not dispatch another consumption batch after the chart is hidden", async () => {
    const manySources = Array.from({ length: 30 }, (_, index) => ({ id: `meter-${index}`, energy: true, power: false }));
    let complete!: (value: AnalyticsQueryResponse) => void;
    const response = new Promise<AnalyticsQueryResponse>((resolve) => { complete = resolve; });
    const request = vi.spyOn(api, "analyticsQuery").mockReturnValue(response);
    const view = renderHook(({ enabled }) => useElectricityHistoryQuery("home", manySources, "1y", "UTC", "live", enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    view.rerender({ enabled: false });
    await waitFor(() => expect(request.mock.calls[0]![1]!.aborted).toBe(true));
    await act(async () => { complete({ series: [] } as unknown as AnalyticsQueryResponse); await response; });
    expect(request).toHaveBeenCalledOnce();
  });
});
