import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { House, HouseWeather } from "@climate-twin/contracts";

const mocks = vi.hoisted(() => ({ houseWeather: vi.fn() }));

vi.mock("./api", () => ({ api: { houseWeather: mocks.houseWeather } }));

import { HOUSE_WEATHER_REFRESH_MS, useHouseWeather } from "./useHouseWeather";

function house(id: string, located = true, latitude = 60.17): House {
  return {
    id,
    name: id,
    timezone: "Europe/Helsinki",
    ...(located ? { location: { latitude, longitude: 24.94 } } : {}),
    floors: [],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

function weather(forHouse: House, temperatureC: number): HouseWeather {
  return {
    houseId: forHouse.id,
    location: forHouse.location!,
    provider: "fmi",
    attribution: "FMI",
    fetchedAt: "2026-07-14T10:01:00.000Z",
    forecastIssuedAt: null,
    stale: false,
    current: { timestamp: "2026-07-14T10:00:00.000Z", temperatureC },
    observationStation: null,
    forecast: [],
    warnings: [],
    unavailable: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useHouseWeather", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("loads 48 hours only when both enabled and located", async () => {
    const located = house("located");
    mocks.houseWeather.mockResolvedValue(weather(located, 3));
    const { result, rerender } = renderHook(
      ({ selected, enabled }) => useHouseWeather(selected, enabled),
      { initialProps: { selected: house("missing", false) as House | null, enabled: true } },
    );
    expect(result.current).toMatchObject({ weather: null, loading: false, error: null });
    expect(mocks.houseWeather).not.toHaveBeenCalled();

    rerender({ selected: located, enabled: false });
    expect(mocks.houseWeather).not.toHaveBeenCalled();

    rerender({ selected: located, enabled: true });
    await waitFor(() => expect(result.current.weather?.houseId).toBe("located"));
    expect(mocks.houseWeather).toHaveBeenCalledWith("located", 48);
  });

  it("ignores a previous house response that resolves after the active house", async () => {
    const first = house("first");
    const second = house("second", true, 61);
    const firstRequest = deferred<HouseWeather>();
    const secondRequest = deferred<HouseWeather>();
    mocks.houseWeather
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { result, rerender } = renderHook(
      ({ selected }) => useHouseWeather(selected),
      { initialProps: { selected: first } },
    );
    rerender({ selected: second });
    await act(async () => secondRequest.resolve(weather(second, 8)));
    expect(result.current.weather?.houseId).toBe("second");

    await act(async () => firstRequest.resolve(weather(first, 1)));
    expect(result.current.weather?.houseId).toBe("second");
    expect(result.current.weather?.current?.temperatureC).toBe(8);
  });

  it("clears weather immediately when the location is removed", async () => {
    const located = house("same");
    mocks.houseWeather.mockResolvedValue(weather(located, 4));
    const { result, rerender } = renderHook(
      ({ selected }) => useHouseWeather(selected),
      { initialProps: { selected: located } },
    );
    await waitFor(() => expect(result.current.weather).not.toBeNull());
    rerender({ selected: house("same", false) });
    expect(result.current).toMatchObject({ weather: null, loading: false, error: null });
  });

  it("preserves the last good result and exposes a transient refresh error", async () => {
    const selected = house("home");
    const saved = weather(selected, 5);
    mocks.houseWeather.mockResolvedValueOnce(saved);
    const { result } = renderHook(() => useHouseWeather(selected));
    await waitFor(() => expect(result.current.weather).toBe(saved));

    mocks.houseWeather.mockRejectedValueOnce(new Error("FMI temporarily unavailable"));
    await act(async () => result.current.refresh());
    expect(result.current.weather).toBe(saved);
    expect(result.current.loading).toBe(false);
    expect(result.current.error?.message).toBe("FMI temporarily unavailable");
  });

  it("refreshes automatically every ten minutes", async () => {
    vi.useFakeTimers();
    const selected = house("timer");
    mocks.houseWeather.mockResolvedValue(weather(selected, 6));
    const { result } = renderHook(() => useHouseWeather(selected));
    await act(async () => Promise.resolve());
    expect(mocks.houseWeather).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(HOUSE_WEATHER_REFRESH_MS);
      await Promise.resolve();
    });
    expect(mocks.houseWeather).toHaveBeenCalledTimes(2);
    expect(result.current.weather?.houseId).toBe("timer");
  });

  it("reuses only the matching house/location cache while refreshing", async () => {
    const first = house("first");
    const second = house("second", true, 61);
    const pendingFirstRefresh = deferred<HouseWeather>();
    mocks.houseWeather
      .mockResolvedValueOnce(weather(first, 2))
      .mockResolvedValueOnce(weather(second, 9))
      .mockReturnValueOnce(pendingFirstRefresh.promise);
    const { result, rerender } = renderHook(
      ({ selected }) => useHouseWeather(selected),
      { initialProps: { selected: first } },
    );
    await waitFor(() => expect(result.current.weather?.current?.temperatureC).toBe(2));
    rerender({ selected: second });
    await waitFor(() => expect(result.current.weather?.current?.temperatureC).toBe(9));
    rerender({ selected: first });
    expect(result.current.weather?.houseId).toBe("first");
    expect(result.current.weather?.current?.temperatureC).toBe(2);
    expect(result.current.loading).toBe(true);
    pendingFirstRefresh.resolve(weather(first, 3));
  });
});
