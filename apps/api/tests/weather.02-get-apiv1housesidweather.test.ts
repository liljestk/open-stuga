import { createServer, type Server } from "node:http";

import type { House, HouseWeather, IntegrationStatus, WeatherUpdateEvent } from "@climate-twin/contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import request from "supertest";

import { createApi, type ApiRuntime } from "../src/app.js";

import type { AppConfig } from "../src/config.js";
import { outdoorLocationKey } from "../src/db.js";

import {
  currentObservation,
  FmiWeatherProvider,
  fmiWarningCoverage,
  parseCapWarnings,
  parseFmiTimeSeries,
  readTextWithByteLimit,
  WeatherRequestSupersededError,
  WeatherService,
  WeatherUnavailableError,
  type FmiTimeSeries,
  type WeatherProvider,
} from "../src/weather.js";

import { config, forecastXml, location, weather } from "./weatherTestSupport.js";

describe("GET /api/v1/houses/:id/weather", () => {
  let runtime: ApiRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    vi.restoreAllMocks();
  });

  it("keeps foreground reads local and serves the monitor's durable canonical snapshot", async () => {
    const provider: WeatherProvider = {
      fetch: vi.fn(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    const events: WeatherUpdateEvent[] = [];
    runtime.weatherEvents.subscribe((event) => events.push(event));

    await request(runtime.app).get("/api/v1/houses/house-main/weather")
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("HOUSE_LOCATION_REQUIRED"));
    expect(provider.fetch).not.toHaveBeenCalled();

    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);
    await request(runtime.app).get("/api/v1/houses/house-main/weather")
      .expect(503)
      .expect(({ body }) => expect(body.error.code).toBe("WEATHER_UNAVAILABLE"));
    expect(provider.fetch).not.toHaveBeenCalled();

    await expect(runtime.weatherMonitor.runOnce()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    const first = await request(runtime.app).get("/api/v1/houses/house-main/weather").query({ hours: 24 }).expect(200);
    const second = await request(runtime.app).get("/api/v1/houses/house-main/weather").query({ hours: 24 }).expect(200);

    expect(first.body.weather).toMatchObject({
      houseId: "house-main",
      location,
      provider: "fmi",
      stale: false,
    });
    expect(second.body).toEqual(first.body);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(provider.fetch).toHaveBeenCalledWith("house-main", location, 48);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "weather.snapshot",
      houseId: "house-main",
      trigger: "scheduled-refresh",
      weather: { provider: "fmi", fetchedAt: "2026-07-14T10:00:00.000Z" },
    });
    expect(runtime.database.getWeatherSnapshot("house-main", outdoorLocationKey(location)))
      .toMatchObject({ lastError: null, weather: { houseId: "house-main", stale: false } });
    await request(runtime.app).get("/api/v1/integrations/status").expect(200)
      .expect(({ body }) => expect(body.mock).toMatchObject({ enabled: false, mode: "real" }));
    expect(runtime.database.db.prepare(`SELECT source, temperature_c AS temperatureC
      FROM outdoor_temperature_samples WHERE house_id = 'house-main' AND source = 'fmi-observation'`).all())
      .toEqual([expect.objectContaining({ source: "fmi-observation", temperatureC: 20.5 })]);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM readings WHERE source = 'mock'").get() as { count: number }).count).toBe(0);
  });

  it("discards an old-location background response before it reaches the snapshot or SSE stream", async () => {
    const firstLocation = { latitude: 60.1699, longitude: 24.9384, label: "Helsinki" };
    const secondLocation = { latitude: 35.6762, longitude: 139.6503, label: "Tokyo" };
    let releaseFirst: ((value: HouseWeather) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const provider: WeatherProvider = {
      fetch: vi.fn((houseId, requestedLocation) => {
        if (requestedLocation.longitude === firstLocation.longitude) {
          signalStarted?.();
          return new Promise<HouseWeather>((resolve) => { releaseFirst = resolve; });
        }
        return Promise.resolve(weather({ houseId, location: requestedLocation }));
      }),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    const events: WeatherUpdateEvent[] = [];
    runtime.weatherEvents.subscribe((event) => events.push(event));
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location: firstLocation }).expect(200);
    const firstLocationKey = outdoorLocationKey(firstLocation);
    const persistedFirstLocationSamples = () => (runtime!.database.db.prepare(`SELECT COUNT(*) AS count
      FROM outdoor_temperature_samples
      WHERE house_id = ? AND location_key = ? AND source = 'fmi-observation'`)
      .get("house-main", firstLocationKey) as { count: number }).count;
    const firstLocationSamplesBeforeRequest = persistedFirstLocationSamples();

    const pendingRefresh = runtime.weatherMonitor.runOnce();
    await started;
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location: secondLocation }).expect(200);
    releaseFirst?.(weather({ location: firstLocation }));

    await expect(pendingRefresh).resolves.toMatchObject({ succeeded: 0, superseded: 1 });
    expect(persistedFirstLocationSamples()).toBe(firstLocationSamplesBeforeRequest);
    expect(events).toEqual([]);
    await request(runtime.app).get("/api/v1/houses/house-main/weather").expect(503);
    await request(runtime.app).get("/api/v1/integrations/status").expect(200).expect(({ body }) => {
      expect(body.weather).toMatchObject({ lastSuccessAt: null, error: null });
      expect(body.mock).toMatchObject({ mode: "demo" });
    });

    await expect(runtime.weatherMonitor.runOnce()).resolves.toMatchObject({ succeeded: 1 });
    const current = await request(runtime.app).get("/api/v1/houses/house-main/weather").expect(200);
    expect(current.body.weather.location).toEqual(secondLocation);
    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.weather.location).toEqual(secondLocation);
  });

  it("turns scheduled pulls from a non-streaming provider into weather events", async () => {
    const provider: WeatherProvider = {
      fetch: vi.fn(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);
    const events: WeatherUpdateEvent[] = [];
    runtime.weatherEvents.subscribe((event) => events.push(event));

    await expect(runtime.weatherMonitor.runOnce()).resolves.toMatchObject({ succeeded: 1, failed: 0 });

    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([expect.objectContaining({
      type: "weather.snapshot",
      trigger: "scheduled-refresh",
      houseId: "house-main",
    })]);
    expect((runtime.database.db.prepare("SELECT COUNT(*) AS count FROM outdoor_temperature_samples").get() as { count: number }).count)
      .toBe(1);
  });

  it("keeps serving the marked-stale last-good snapshot after a background refresh fails", async () => {
    let now = Date.parse("2026-08-08T08:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const provider: WeatherProvider = {
      fetch: vi.fn()
        .mockResolvedValueOnce(weather({ fetchedAt: new Date(now).toISOString() }))
        .mockRejectedValueOnce(new WeatherUnavailableError("FMI offline")),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);

    await expect(runtime.weatherMonitor.runOnce()).resolves.toMatchObject({ succeeded: 1 });
    now += 11 * 60_000;
    await expect(runtime.weatherMonitor.runOnce()).resolves.toMatchObject({ failed: 1, lastError: "FMI offline" });

    const response = await request(runtime.app).get("/api/v1/houses/house-main/weather").expect(200);
    expect(response.body.weather).toMatchObject({
      houseId: "house-main",
      stale: true,
      current: { temperatureC: 20.5 },
    });
    expect(runtime.database.getWeatherSnapshot("house-main", outdoorLocationKey(location)))
      .toMatchObject({ lastError: "FMI offline", weather: { stale: false } });
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("fans accepted weather snapshots out through the existing SSE stream with a stable event ID", async () => {
    const provider: WeatherProvider = {
      fetch: vi.fn(async (houseId, requestedLocation) => weather({ houseId, location: requestedLocation })),
    };
    runtime = createApi({ config, weatherProvider: provider, startBackground: false });
    await request(runtime.app).patch("/api/v1/houses/house-main").send({ location }).expect(200);

    const server: Server = createServer(runtime.app);
    const controller = new AbortController();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
      const stream = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, { signal: controller.signal });
      const reader = stream.body?.getReader();
      if (!reader) throw new Error("SSE response did not expose a body");
      await reader.read(); // immediate integration snapshot

      const refresh = runtime!.weatherMonitor.runOnce();
      const readWeatherEvent = async (): Promise<string> => {
        let payload = "";
        while (!payload.includes("event: weather")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          payload += new TextDecoder().decode(chunk.value);
        }
        return payload;
      };
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const payload = await Promise.race([
        readWeatherEvent(),
        new Promise<string>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Timed out waiting for weather SSE event")), 2_000);
        }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      await refresh;

      expect(payload).toMatch(/id: weather-[a-f0-9]{64}/);
      expect(payload).toContain("event: weather");
      expect(payload).toContain('"type":"weather.snapshot"');
      expect(payload).toContain('"houseId":"house-main"');
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
