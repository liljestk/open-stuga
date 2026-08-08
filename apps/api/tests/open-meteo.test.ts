import { describe, expect, it, vi } from "vitest";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider, openMeteoConditions, prefersFmi } from "../src/open-meteo.js";
import type { HouseWeather } from "@climate-twin/contracts";

describe("Open-Meteo weather provider", () => {
  it("forwards cancellation to an Open-Meteo historical observation request", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: fetchImpl as typeof fetch });
    const controller = new AbortController();
    const reason = new Error("cancel Open-Meteo recovery");

    const pending = provider.fetchObservationHistory(
      "global-home",
      { latitude: -36.85, longitude: 174.76 },
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T11:00:00.000Z",
      controller.signal,
    );
    await requestStarted;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("normalizes UTC model values into the canonical outdoor contract", () => {
    expect(openMeteoConditions({
      time: ["2026-07-14T12:00"],
      temperature_2m: [18.4],
      wind_speed_10m: [3.2],
      snow_depth: [0.12],
      weather_code: [61],
    }, 0)).toMatchObject({
      timestamp: "2026-07-14T12:00:00.000Z",
      temperatureC: 18.4,
      windSpeedMps: 3.2,
      snowDepthCm: 12,
      presentWeatherCode: 61,
    });
  });

  it("omits null and empty upstream values instead of inventing zeroes", () => {
    expect(openMeteoConditions({
      time: "2026-07-14T12:00", temperature_2m: null, relative_humidity_2m: "", pressure_msl: undefined,
    })).toEqual({ timestamp: "2026-07-14T12:00:00.000Z" });
  });

  it("marks global forecasts available without claiming warning coverage", async () => {
    const now = new Date("2026-07-14T10:15:00.000Z");
    const hourlyTimes = Array.from({ length: 49 }, (_, index) => new Date(
      Date.parse("2026-07-14T10:00:00.000Z") + index * 3_600_000,
    ).toISOString().slice(0, 16));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      current: { time: "2026-07-14T10:15", temperature_2m: 20, relative_humidity_2m: 45 },
      hourly: {
        time: hourlyTimes,
        temperature_2m: hourlyTimes.map((_, index) => 19 + index / 10),
        precipitation_probability: hourlyTimes.map((_, index) => index),
      },
    })));
    const provider = new OpenMeteoWeatherProvider({ fetchImpl, now: () => now });
    const weather = await provider.fetch("auckland", { latitude: -36.85, longitude: 174.76 }, 48);

    expect(weather.provider).toBe("open-meteo");
    expect(weather.attribution).toBe("Weather data by Open-Meteo.com (CC BY 4.0)");
    expect(weather.forecast).toHaveLength(48);
    expect(weather.forecast[0]?.timestamp).toBe("2026-07-14T11:00:00.000Z");
    expect(weather.warnings).toEqual([]);
    expect(weather.componentStatus?.warnings).toMatchObject({
      provider: "open-meteo",
      attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
      availability: "not-applicable",
      coverage: "outside-coverage",
      emptyResultIsAuthoritative: false,
    });
    expect(weather.unavailable).toContain("warnings");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("wind_speed_unit=ms");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("forecast_hours=49");
  });

  it("selects the provider deterministically by coverage", async () => {
    expect(prefersFmi({ latitude: 60.17, longitude: 24.94 })).toBe(true);
    expect(prefersFmi({ latitude: -36.85, longitude: 174.76 })).toBe(false);
    expect(prefersFmi({ latitude: 59.44, longitude: 24.75, countryCode: "EE" })).toBe(false);
    expect(prefersFmi({ latitude: 59.33, longitude: 18.07 })).toBe(false);
    expect(prefersFmi({ latitude: 60.17, longitude: 24.94, countryCode: "SE" })).toBe(false);
    const fmi = { fetch: vi.fn().mockResolvedValue({ provider: "fmi" } as HouseWeather) };
    const worldwide = { fetch: vi.fn().mockResolvedValue({ provider: "open-meteo" } as HouseWeather) };
    const router = new AutomaticWeatherProvider(fmi, worldwide);
    await router.fetch("one", { latitude: 60.17, longitude: 24.94 }, 48);
    await router.fetch("two", { latitude: -36.85, longitude: 174.76 }, 48);
    expect(fmi.fetch).toHaveBeenCalledOnce();
    expect(worldwide.fetch).toHaveBeenCalledOnce();
  });

  it("forwards the recovery signal through the automatic provider", async () => {
    const reason = new Error("history unavailable");
    const fmi = {
      fetch: vi.fn(),
      fetchObservationHistory: vi.fn().mockRejectedValue(reason),
    };
    const router = new AutomaticWeatherProvider(fmi, { fetch: vi.fn() });
    const controller = new AbortController();

    await expect(router.fetchObservationHistory(
      "one",
      { latitude: 60.17, longitude: 24.94 },
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T11:00:00.000Z",
      controller.signal,
    )).rejects.toBe(reason);
    expect(fmi.fetchObservationHistory).toHaveBeenCalledWith(
      "one",
      { latitude: 60.17, longitude: 24.94 },
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T11:00:00.000Z",
      controller.signal,
    );
  });
});
