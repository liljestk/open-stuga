import type { HouseWeather, WeatherComponentStatuses } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimateDatabase, outdoorLocationKey } from "../src/db.js";
import { WeatherRecoveryCoordinator } from "../src/weather-recovery.js";
import type { WeatherProvider } from "../src/weather.js";
import type { HybridTelemetryReader } from "../src/timeseries/read-facade.js";

const location = { latitude: 60.1699, longitude: 24.9384, countryCode: "FI", label: "Helsinki" };

function statuses(unavailable: Array<keyof WeatherComponentStatuses> = []): WeatherComponentStatuses {
  const component = (name: keyof WeatherComponentStatuses) => ({
    provider: "fmi" as const,
    product: name,
    attribution: "FMI open data",
    availability: unavailable.includes(name) ? "unavailable" as const : "available" as const,
    coverage: "covered" as const,
    emptyResultIsAuthoritative: !unavailable.includes(name),
    fetchedAt: "2026-07-14T11:00:00.000Z",
    stale: false,
  });
  return {
    observation: component("observation"),
    forecast: component("forecast"),
    "short-range": component("short-range"),
    warnings: component("warnings"),
  };
}

function weather(unavailable: HouseWeather["unavailable"] = []): HouseWeather {
  return {
    houseId: "house-main",
    location,
    provider: "fmi",
    attribution: "FMI open data",
    fetchedAt: "2026-07-14T11:00:00.000Z",
    forecastIssuedAt: "2026-07-14T10:00:00.000Z",
    stale: false,
    current: { timestamp: "2026-07-14T10:50:00.000Z", temperatureC: 20 },
    observationStation: { id: "station-1", name: "Kaisaniemi", latitude: 60.17, longitude: 24.94, distanceKm: 1 },
    forecast: [{ timestamp: "2026-07-14T12:00:00.000Z", temperatureC: 21 }],
    warnings: [],
    unavailable,
    componentStatus: statuses(unavailable),
  };
}

describe("WeatherRecoveryCoordinator", () => {
  let database: ClimateDatabase | undefined;

  afterEach(() => database?.close());

  it("durably records an outage and backfills full observations after recovery", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const provider: WeatherProvider = {
      fetch: vi.fn(),
      fetchObservationHistory: vi.fn(async (_houseId, requestedLocation, from, to) => ({
        houseId: house.id,
        location: requestedLocation,
        provider: "fmi",
        attribution: "FMI open data",
        fetchedAt: "2026-07-14T11:01:00.000Z",
        station: { id: "station-1", name: "Kaisaniemi", latitude: 60.17, longitude: 24.94, distanceKm: 1 },
        observations: [
          { timestamp: "2026-07-14T10:10:00.000Z", temperatureC: 18.2, relativeHumidityPercent: 71, windSpeedMps: 2.4 },
          { timestamp: "2026-07-14T10:20:00.000Z", temperatureC: 18.4, relativeHumidityPercent: 70, windSpeedMps: 2.6 },
        ].filter((point) => point.timestamp >= from && point.timestamp <= to),
      })),
    };
    const recovery = new WeatherRecoveryCoordinator(database, provider);

    recovery.recordFailure(house, new Error("FMI returned HTTP 503"), "2026-07-14T10:00:00.000Z");
    expect(recovery.status(house)).toMatchObject({
      active: true,
      affectedComponents: ["service"],
      lastError: "FMI returned HTTP 503",
      observationBackfill: { state: "pending" },
    });

    recovery.recordSuccess(house, weather());
    await recovery.drain();

    expect(provider.fetchObservationHistory).toHaveBeenCalledWith(
      house.id,
      location,
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T11:00:00.000Z",
      expect.any(AbortSignal),
    );
    const history = database.outdoorTemperatureHistory(
      house.id,
      outdoorLocationKey(location),
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T11:00:00.000Z",
    );
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      source: "fmi-backfill",
      stationId: "station-1",
      conditions: { relativeHumidityPercent: 71, windSpeedMps: 2.4 },
    });
    expect(recovery.status(house)).toMatchObject({
      active: false,
      observationBackfill: { state: "complete", recoveredPoints: 2 },
    });
  });

  it("records partial component outages without fabricating past forecasts or warnings", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const provider: WeatherProvider = { fetch: vi.fn(), fetchObservationHistory: vi.fn() };
    const recovery = new WeatherRecoveryCoordinator(database, provider);

    recovery.recordSuccess(house, weather(["forecast", "warnings"]));
    expect(recovery.status(house)).toMatchObject({
      active: true,
      affectedComponents: expect.arrayContaining(["forecast", "warnings"]),
    });

    recovery.recordSuccess(house, weather());
    await recovery.drain();

    const outages = database.listWeatherOutages(house.id, outdoorLocationKey(location));
    expect(outages).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "forecast", backfillState: "not-supported" }),
      expect.objectContaining({ component: "warnings", backfillState: "not-supported" }),
    ]));
    expect(provider.fetchObservationHistory).not.toHaveBeenCalled();
  });

  it("discovers and backfills historical FMI holes that were not recorded as live outages", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    for (const [timestamp, temperatureC] of [
      ["2026-07-14T10:20:00.000Z", 19],
      ["2026-07-14T10:50:00.000Z", 19.2],
    ] as const) {
      database.upsertCurrentOutdoorTemperatureSample({
        houseId: house.id,
        locationKey,
        timestamp,
        temperatureC,
        source: "fmi-observation",
        fetchedAt: timestamp,
        stationId: "station-1",
        stationName: "Kaisaniemi",
      });
    }
    const onRecovered = vi.fn();
    const provider: WeatherProvider = {
      fetch: vi.fn(),
      fetchObservationHistory: vi.fn(async (_houseId, requestedLocation, from, to) => ({
        houseId: house.id,
        location: requestedLocation,
        provider: "fmi",
        attribution: "FMI open data",
        fetchedAt: "2026-07-14T11:01:00.000Z",
        station: { id: "station-1", name: "Kaisaniemi", latitude: 60.17, longitude: 24.94, distanceKm: 1 },
        observations: [
          { timestamp: "2026-07-14T10:30:00.000Z", temperatureC: 19.1 },
        ].filter((point) => point.timestamp >= from && point.timestamp <= to),
      })),
    };
    const recovery = new WeatherRecoveryCoordinator(database, provider, { onRecovered });

    recovery.recordSuccess(house, {
      ...weather(),
      fetchedAt: "2026-07-14T11:01:00.000Z",
      current: { timestamp: "2026-07-14T10:50:00.000Z", temperatureC: 19.3 },
    });
    await recovery.drain();

    expect(provider.fetchObservationHistory).toHaveBeenCalledWith(
      house.id,
      location,
      "2026-07-14T10:20:00.000Z",
      "2026-07-14T10:50:00.000Z",
      expect.any(AbortSignal),
    );
    expect(database.outdoorTemperatureHistory(
      house.id,
      locationKey,
      "2026-07-14T10:20:00.000Z",
      "2026-07-14T10:50:00.000Z",
    )).toHaveLength(3);
    expect(database.listWeatherOutages(house.id, locationKey)).toEqual([
      expect.objectContaining({
        component: "observation",
        backfillFrom: "2026-07-14T10:20:00.000Z",
        backfillTo: "2026-07-14T10:50:00.000Z",
        backfillState: "complete",
        recoveredPoints: 1,
      }),
    ]);
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it("tolerates ordinary ten-to-twenty-minute FMI observation spacing", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    for (const timestamp of [
      "2026-07-14T10:10:00.000Z",
      "2026-07-14T10:20:00.000Z",
      "2026-07-14T10:40:00.000Z",
    ]) {
      database.upsertCurrentOutdoorTemperatureSample({
        houseId: house.id,
        locationKey,
        timestamp,
        temperatureC: 19,
        source: "fmi-observation",
        fetchedAt: timestamp,
        stationId: "station-1",
        stationName: "Kaisaniemi",
      });
    }
    const provider: WeatherProvider = { fetch: vi.fn(), fetchObservationHistory: vi.fn() };
    const recovery = new WeatherRecoveryCoordinator(database, provider);

    recovery.recordSuccess(house, weather());
    await recovery.drain();

    expect(database.listWeatherOutages(house.id, locationKey)).toEqual([]);
    expect(provider.fetchObservationHistory).not.toHaveBeenCalled();
  });

  it("persists a bounded discovery checkpoint and scans only an overlapped recent window every six hours", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    let now = Date.parse("2026-07-14T12:00:00.000Z");
    const readHistory = vi.fn(async () => ({ records: [], provenance: {} as never }));
    const telemetryReader = { outdoorTemperatureHistory: readHistory } as unknown as HybridTelemetryReader;
    const provider: WeatherProvider = { fetch: vi.fn(), fetchObservationHistory: vi.fn() };
    const first = new WeatherRecoveryCoordinator(database, provider, { telemetryReader, now: () => now });

    first.recordSuccess(house, weather());
    await first.drain();
    expect(readHistory).toHaveBeenCalledOnce();
    expect(readHistory).toHaveBeenLastCalledWith(expect.objectContaining({
      from: "2026-07-13T10:50:00.000Z",
      to: "2026-07-14T10:50:00.000Z",
      limit: 2_000,
      signal: expect.any(AbortSignal),
    }));
    await first.stop();

    const restarted = new WeatherRecoveryCoordinator(database, provider, { telemetryReader, now: () => now });
    now += 60 * 60_000;
    restarted.recordSuccess(house, {
      ...weather(),
      fetchedAt: "2026-07-14T12:00:00.000Z",
      current: { timestamp: "2026-07-14T11:50:00.000Z", temperatureC: 20 },
    });
    await restarted.drain();
    expect(readHistory).toHaveBeenCalledOnce();

    now += 5 * 60 * 60_000;
    restarted.recordSuccess(house, {
      ...weather(),
      fetchedAt: "2026-07-14T17:00:00.000Z",
      current: { timestamp: "2026-07-14T16:50:00.000Z", temperatureC: 20 },
    });
    await restarted.drain();
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(readHistory).toHaveBeenLastCalledWith(expect.objectContaining({
      // Two FMI gap intervals overlap the completed checkpoint boundary.
      from: "2026-07-14T10:00:00.000Z",
      to: "2026-07-14T16:50:00.000Z",
      limit: 2_000,
      signal: expect.any(AbortSignal),
    }));
    await restarted.stop();
  });

  it("coalesces duplicate discovery requests and aborts an archive read on stop", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const readHistory = vi.fn(async (query: { signal?: AbortSignal }) => {
      signal = query.signal;
      started();
      return new Promise<never>((_resolve, reject) => {
        query.signal?.addEventListener("abort", () => reject(query.signal?.reason), { once: true });
      });
    });
    const telemetryReader = { outdoorTemperatureHistory: readHistory } as unknown as HybridTelemetryReader;
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory: vi.fn() },
      { telemetryReader },
    );

    recovery.recordSuccess(house, weather());
    recovery.recordSuccess(house, weather());
    await readStarted;
    await recovery.stop();

    expect(readHistory).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });

  it("aborts an explicit backfill while its archive history read is pending", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const readHistory = vi.fn((query: { signal?: AbortSignal }) => {
      signal = query.signal;
      started();
      return new Promise<never>((_resolve, reject) => {
        query.signal?.addEventListener("abort", () => reject(query.signal?.reason), { once: true });
      });
    });
    const recovery = new WeatherRecoveryCoordinator(
      database,
      {
        fetch: vi.fn(),
        fetchObservationHistory: vi.fn(async (_houseId, requestedLocation) => ({
          houseId: house.id,
          location: requestedLocation,
          provider: "fmi",
          attribution: "FMI open data",
          fetchedAt: "2026-07-14T11:01:00.000Z",
          station: null,
          observations: [],
        })),
      },
      { telemetryReader: { outdoorTemperatureHistory: readHistory } as unknown as HybridTelemetryReader },
    );
    recovery.recordFailure(house, new Error("provider unavailable"), "2026-07-14T10:00:00.000Z");
    recovery.recordSuccess(house, weather(["observation"]));
    await readStarted;

    await expect(Promise.race([
      recovery.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stop timed out")), 250)),
    ])).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(database.listWeatherOutages(house.id, locationKey).find((outage) => outage.component === "service"))
      .toMatchObject({ backfillState: "pending", recoveredPoints: 0 });
  });

  it("aborts an explicit backfill while the provider history fetch is pending", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const provider: WeatherProvider = {
      fetch: vi.fn(),
      fetchObservationHistory: vi.fn((_houseId, _location, _from, _to, requestSignal) => {
        signal = requestSignal;
        started();
        return new Promise<never>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
        });
      }),
    };
    const recovery = new WeatherRecoveryCoordinator(database, provider);
    recovery.recordFailure(house, new Error("provider unavailable"), "2026-07-14T10:00:00.000Z");
    recovery.recordSuccess(house, weather(["observation"]));
    await fetchStarted;

    await expect(Promise.race([
      recovery.stop(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stop timed out")), 250)),
    ])).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(database.listWeatherOutages(house.id, locationKey).find((outage) => outage.component === "service"))
      .toMatchObject({ backfillState: "pending", recoveredPoints: 0 });
  });

  it("bounds a multi-day outage to one chunk, persists its cursor, and resumes without duplicate calls", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    const outageFrom = "2026-07-10T00:00:00.000Z";
    const outageTo = "2026-07-13T00:00:00.000Z";
    const recoveredWeather: HouseWeather = {
      ...weather(["observation"]),
      fetchedAt: outageTo,
      current: { timestamp: outageTo, temperatureC: 20 },
    };
    const fetchObservationHistory = vi.fn(async (_houseId, requestedLocation, from, to) => ({
      houseId: house.id,
      location: requestedLocation,
      provider: "fmi" as const,
      attribution: "FMI open data",
      fetchedAt: to,
      station: null,
      observations: [{
        timestamp: new Date(Date.parse(from) + 10 * 60_000).toISOString(),
        temperatureC: 18,
      }],
    }));
    const readHistory = vi.fn(async () => ({ records: [], provenance: {} as never }));
    const telemetryReader = { outdoorTemperatureHistory: readHistory } as unknown as HybridTelemetryReader;
    const provider: WeatherProvider = { fetch: vi.fn(), fetchObservationHistory };
    const first = new WeatherRecoveryCoordinator(database, provider, { telemetryReader });

    first.recordFailure(house, new Error("long provider outage"), outageFrom);
    first.recordSuccess(house, recoveredWeather);
    await first.drain();

    expect(fetchObservationHistory).toHaveBeenCalledTimes(1);
    expect(fetchObservationHistory).toHaveBeenLastCalledWith(
      house.id,
      location,
      "2026-07-10T00:00:00.000Z",
      "2026-07-11T00:00:00.000Z",
      expect.any(AbortSignal),
    );
    expect(readHistory).toHaveBeenCalledWith(expect.objectContaining({
      from: "2026-07-10T00:00:00.000Z",
      to: "2026-07-11T00:00:00.000Z",
      limit: 384,
    }));
    expect(database.listWeatherOutages(house.id, locationKey).find((outage) => outage.component === "service"))
      .toMatchObject({
        backfillState: "partial",
        backfillFrom: outageFrom,
        backfillTo: outageTo,
        recoveredPoints: 1,
      });
    await first.stop();

    const restarted = new WeatherRecoveryCoordinator(database, provider, {
      telemetryReader,
      backfillRescheduleMs: 1,
    });
    restarted.recordSuccess(house, recoveredWeather);
    await vi.waitFor(() => {
      expect(fetchObservationHistory).toHaveBeenCalledTimes(3);
      expect(database.listWeatherOutages(house.id, locationKey).find((outage) => outage.component === "service"))
        .toMatchObject({ backfillState: "complete", recoveredPoints: 3 });
    });
    expect(fetchObservationHistory.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["2026-07-10T00:00:00.000Z", "2026-07-11T00:00:00.000Z"],
      ["2026-07-11T00:00:00.000Z", "2026-07-12T00:00:00.000Z"],
      ["2026-07-12T00:00:00.000Z", "2026-07-13T00:00:00.000Z"],
    ]);
    expect(readHistory).toHaveBeenCalledTimes(3);
    await restarted.stop();
  });

  it("shares one chunk budget across multiple resolved outages in the same cycle", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    for (const hour of [7, 8, 9]) {
      database.noteHistoricalWeatherObservationGap(
        house.id,
        locationKey,
        "fmi",
        `2026-07-14T0${hour}:00:00.000Z`,
        `2026-07-14T${String(hour + 1).padStart(2, "0")}:00:00.000Z`,
        "2026-07-14T11:00:00.000Z",
      );
    }
    const fetchObservationHistory = vi.fn(async (_houseId, requestedLocation, _from, to) => ({
      houseId: house.id,
      location: requestedLocation,
      provider: "fmi" as const,
      attribution: "FMI open data",
      fetchedAt: to,
      station: null,
      observations: [],
    }));
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory },
    );

    recovery.recordSuccess(house, weather(["observation"]));
    await recovery.drain();

    expect(fetchObservationHistory).toHaveBeenCalledOnce();
    expect(database.listWeatherOutages(house.id, locationKey)
      .filter((outage) => outage.endedAt !== null)
      .map((outage) => outage.backfillState)
      .sort()).toEqual(["complete", "pending", "pending"]);
    await recovery.stop();
  });

  it("fails safely before an oversized provider result can exceed the point budget", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    const fetchObservationHistory = vi.fn(async (_houseId, requestedLocation) => ({
      houseId: house.id,
      location: requestedLocation,
      provider: "fmi" as const,
      attribution: "FMI open data",
      fetchedAt: "2026-07-14T11:00:00.000Z",
      station: null,
      observations: Array.from({ length: 769 }, (_, index) => ({
        timestamp: new Date(Date.parse("2026-07-14T10:00:00.000Z") + index).toISOString(),
        temperatureC: 18,
      })),
    }));
    const readHistory = vi.fn(async () => ({ records: [], provenance: {} as never }));
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory },
      { telemetryReader: { outdoorTemperatureHistory: readHistory } as unknown as HybridTelemetryReader },
    );

    recovery.recordFailure(house, new Error("provider outage"), "2026-07-14T10:00:00.000Z");
    recovery.recordSuccess(house, weather(["observation"]));
    await recovery.drain();

    expect(fetchObservationHistory).toHaveBeenCalledOnce();
    expect(readHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 384 }));
    expect(database.listWeatherOutages(house.id, locationKey).find((outage) => outage.component === "service"))
      .toMatchObject({
        backfillState: "failed",
        recoveredPoints: 0,
        backfillError: expect.stringContaining("safe per-cycle point budget"),
      });
    await recovery.stop();
  });

  it("rotates retries across failed outages instead of starving later failures", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    for (const [from, to] of [
      ["2026-07-14T07:00:00.000Z", "2026-07-14T08:00:00.000Z"],
      ["2026-07-14T08:00:00.000Z", "2026-07-14T09:00:00.000Z"],
    ] as const) {
      const outage = database.noteHistoricalWeatherObservationGap(
        house.id,
        locationKey,
        "fmi",
        from,
        to,
        "2026-07-14T10:00:00.000Z",
      );
      database.updateWeatherOutageBackfill(outage.id, "failed", 0, from, "initial failure");
    }
    let now = Date.parse("2026-07-14T12:00:00.000Z");
    const fetchObservationHistory = vi.fn(async () => {
      throw new Error("provider remains unavailable");
    });
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory },
      { now: () => now },
    );

    recovery.recordSuccess(house, weather(["observation"]));
    await recovery.drain();
    now += 1;
    recovery.recordSuccess(house, weather(["observation"]));
    await recovery.drain();

    expect(fetchObservationHistory.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["2026-07-14T07:00:00.000Z", "2026-07-14T08:00:00.000Z"],
      ["2026-07-14T08:00:00.000Z", "2026-07-14T09:00:00.000Z"],
    ]);
    await recovery.stop();
  });

  it("finds an old pending backfill even when newer non-recoverable rows exceed the general list limit", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    const pending = database.noteHistoricalWeatherObservationGap(
      house.id,
      locationKey,
      "fmi",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T01:00:00.000Z",
      "2026-07-01T02:00:00.000Z",
    );
    const insert = database.db.prepare(`INSERT INTO weather_outages
      (house_id, location_key, provider, component, started_at, last_seen_at, ended_at, last_error,
       backfill_state, backfill_from, backfill_to, recovered_points, last_attempt_at, backfill_error)
      VALUES (?, ?, 'fmi', 'forecast', ?, ?, ?, 'historical forecast unavailable',
       'not-supported', NULL, NULL, 0, NULL, NULL)`);
    database.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        const timestamp = new Date(Date.parse("2026-07-15T00:00:00.000Z") + index * 60_000).toISOString();
        insert.run(house.id, locationKey, timestamp, timestamp, timestamp);
      }
    });
    const fetchObservationHistory = vi.fn(async (_houseId, requestedLocation, _from, to) => ({
      houseId: house.id,
      location: requestedLocation,
      provider: "fmi" as const,
      attribution: "FMI open data",
      fetchedAt: to,
      station: null,
      observations: [],
    }));
    const recovery = new WeatherRecoveryCoordinator(database, { fetch: vi.fn(), fetchObservationHistory });

    expect(database.listWeatherOutages(house.id, locationKey, 500).some((outage) => outage.id === pending.id)).toBe(false);
    expect(recovery.status(house).observationBackfill.state).toBe("pending");
    recovery.recordSuccess(house, weather());
    await recovery.drain();

    expect(fetchObservationHistory).toHaveBeenCalledWith(
      house.id,
      location,
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T01:00:00.000Z",
      expect.any(AbortSignal),
    );
    expect(database.listPendingWeatherBackfills(house.id, locationKey, "fmi")).toEqual([]);
    expect(recovery.status(house).observationBackfill.state).toBe("complete");
    await recovery.stop();
  });

  it("commits samples, derived invalidation, cursor, and outage progress atomically", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    database.noteWeatherOutage(
      house.id,
      locationKey,
      "fmi",
      "service",
      "provider unavailable",
      "2026-07-14T10:00:00.000Z",
    );
    database.resolveWeatherOutages(
      house.id,
      locationKey,
      "fmi",
      ["service"],
      "2026-07-16T10:00:00.000Z",
    );
    const outage = database.listPendingWeatherBackfills(house.id, locationKey, "fmi")[0]!;
    database.db.exec(`CREATE TRIGGER fail_weather_backfill_progress
      BEFORE UPDATE OF backfill_state ON weather_outages
      WHEN OLD.backfill_state = 'running' AND NEW.backfill_state IN ('pending', 'partial', 'complete')
      BEGIN SELECT RAISE(ABORT, 'injected progress failure'); END;`);
    const fetchObservationHistory = vi.fn(async (_houseId, requestedLocation, _from, to) => ({
      houseId: house.id,
      location: requestedLocation,
      provider: "fmi" as const,
      attribution: "FMI open data",
      fetchedAt: to,
      station: null,
      observations: [{ timestamp: "2026-07-14T10:30:00.000Z", temperatureC: 18 }],
    }));
    const recovery = new WeatherRecoveryCoordinator(database, { fetch: vi.fn(), fetchObservationHistory });

    recovery.recordSuccess(house, weather(["observation"]));
    await recovery.drain();

    expect(database.outdoorTemperatureHistory(
      house.id,
      locationKey,
      "2026-07-14T10:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
    )).toEqual([]);
    expect(database.db.prepare("SELECT value FROM metadata WHERE key = ?")
      .get(`weather-backfill-cursor-v1:${outage.id}`)).toBeUndefined();
    expect(database.listPendingWeatherBackfills(house.id, locationKey, "fmi")[0])
      .toMatchObject({ id: outage.id, backfillState: "failed", recoveredPoints: 0 });

    database.db.exec("DROP TRIGGER fail_weather_backfill_progress");
    recovery.recordSuccess(house, weather(["observation"]));
    await recovery.drain();

    expect(fetchObservationHistory).toHaveBeenCalledTimes(2);
    expect(fetchObservationHistory.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["2026-07-14T10:00:00.000Z", "2026-07-15T10:00:00.000Z"],
      ["2026-07-14T10:00:00.000Z", "2026-07-15T10:00:00.000Z"],
    ]);
    expect(database.outdoorTemperatureHistory(
      house.id,
      locationKey,
      "2026-07-14T10:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
    )).toHaveLength(1);
    expect(database.listWeatherOutages(house.id, locationKey).find((candidate) => candidate.id === outage.id))
      .toMatchObject({ backfillState: "partial", recoveredPoints: 1 });
    expect(database.db.prepare("SELECT value FROM metadata WHERE key = ?")
      .get(`weather-backfill-cursor-v1:${outage.id}`))
      .toMatchObject({ value: expect.stringContaining("2026-07-15T10:00:00.000Z") });
    await recovery.stop();
  });

  it("does not let a slower discovery bypass an existing backfill cooldown", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    let releaseDiscovery!: (value: { records: Array<Record<string, unknown>>; provenance: never }) => void;
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { discoveryStarted = resolve; });
    const discovery = new Promise<{ records: Array<Record<string, unknown>>; provenance: never }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const readHistory = vi.fn((query: { from: string }) => {
      if (query.from === "2026-07-13T10:50:00.000Z") {
        discoveryStarted();
        return discovery;
      }
      return Promise.resolve({ records: [], provenance: {} as never });
    });
    const fetchObservationHistory = vi.fn(async (_houseId, requestedLocation, _from, to) => ({
      houseId: house.id,
      location: requestedLocation,
      provider: "fmi" as const,
      attribution: "FMI open data",
      fetchedAt: to,
      station: null,
      observations: [],
    }));
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory },
      {
        telemetryReader: { outdoorTemperatureHistory: readHistory } as unknown as HybridTelemetryReader,
        backfillRescheduleMs: 10_000,
      },
    );
    recovery.recordFailure(house, new Error("long outage"), "2026-07-10T00:00:00.000Z");
    recovery.recordSuccess(house, weather());
    await started;
    const serviceOutage = database.listPendingWeatherBackfills(house.id, locationKey, "fmi")
      .find((candidate) => candidate.component === "service")!;
    await vi.waitFor(() => {
      const cursor = database.db.prepare("SELECT value FROM metadata WHERE key = ?")
        .get(`weather-backfill-cursor-v1:${serviceOutage.id}`) as { value?: string } | undefined;
      expect(cursor?.value).toContain("2026-07-11T00:00:00.000Z");
    });

    releaseDiscovery({
      records: [
        {
          houseId: house.id,
          locationKey,
          timestamp: "2026-07-14T10:00:00.000Z",
          temperatureC: 18,
          source: "fmi-observation",
          fetchedAt: "2026-07-14T10:00:00.000Z",
        },
        {
          houseId: house.id,
          locationKey,
          timestamp: "2026-07-14T10:30:00.000Z",
          temperatureC: 18.5,
          source: "fmi-observation",
          fetchedAt: "2026-07-14T10:30:00.000Z",
        },
      ],
      provenance: {} as never,
    });
    await recovery.drain();

    expect(fetchObservationHistory).toHaveBeenCalledOnce();
    expect(database.listPendingWeatherBackfills(house.id, locationKey, "fmi")).toHaveLength(2);
    await recovery.stop();
  });

  it("does not resurrect backfill work after an active discovery is invalidated", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { discoveryStarted = resolve; });
    const readHistory = vi.fn((query: { signal?: AbortSignal }) => {
      discoveryStarted();
      return new Promise<never>((_resolve, reject) => {
        query.signal?.addEventListener("abort", () => reject(query.signal?.reason), { once: true });
      });
    });
    const fetchObservationHistory = vi.fn();
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory },
      { telemetryReader: { outdoorTemperatureHistory: readHistory } as unknown as HybridTelemetryReader },
    );

    recovery.recordSuccess(house, weather());
    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));
    database.noteHistoricalWeatherObservationGap(
      house.id,
      locationKey,
      "fmi",
      "2026-07-14T09:00:00.000Z",
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T11:00:00.000Z",
    );

    recovery.invalidate(house.id);
    await recovery.drain();

    expect(fetchObservationHistory).not.toHaveBeenCalled();
    expect(database.listPendingWeatherBackfills(house.id, locationKey, "fmi"))
      .toEqual([expect.objectContaining({ backfillState: "pending" })]);
    await recovery.stop();
  });

  it("enforces the wall-time budget and leaves durable pending work for rescheduling", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchObservationHistory = vi.fn((_houseId, _location, _from, _to, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      started();
      return new Promise<never>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
    });
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory },
      { backfillWallTimeMs: 20, backfillRescheduleMs: 10_000 },
    );

    recovery.recordFailure(house, new Error("long outage"), "2026-07-10T00:00:00.000Z");
    recovery.recordSuccess(house, {
      ...weather(["observation"]),
      fetchedAt: "2026-07-13T00:00:00.000Z",
    });
    await fetchStarted;
    await recovery.drain();

    expect(signal?.aborted).toBe(true);
    expect(fetchObservationHistory).toHaveBeenCalledOnce();
    expect(database.listWeatherOutages(house.id, locationKey).find((outage) => outage.component === "service"))
      .toMatchObject({ backfillState: "pending", recoveredPoints: 0, backfillError: null });
    await recovery.stop();
  });

  it("invalidates a pending chunk promptly without fetching a second long-outage chunk", async () => {
    database = new ClimateDatabase(":memory:");
    const house = database.updateHouse("house-main", { location })!;
    const locationKey = outdoorLocationKey(location);
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    const fetchObservationHistory = vi.fn((_houseId, _location, _from, _to, requestSignal?: AbortSignal) => {
      signal = requestSignal;
      started();
      return new Promise<never>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
    });
    const recovery = new WeatherRecoveryCoordinator(
      database,
      { fetch: vi.fn(), fetchObservationHistory },
    );
    recovery.recordFailure(house, new Error("long outage"), "2026-07-10T00:00:00.000Z");
    recovery.recordSuccess(house, {
      ...weather(["observation"]),
      fetchedAt: "2026-07-13T00:00:00.000Z",
    });
    await fetchStarted;

    recovery.invalidate(house.id);
    await expect(Promise.race([
      recovery.drain(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("invalidate timed out")), 250)),
    ])).resolves.toBeUndefined();

    expect(signal?.aborted).toBe(true);
    expect(fetchObservationHistory).toHaveBeenCalledOnce();
    expect(database.listWeatherOutages(house.id, locationKey).find((outage) => outage.component === "service"))
      .toMatchObject({ backfillState: "pending", recoveredPoints: 0 });
    await recovery.stop();
  });
});
