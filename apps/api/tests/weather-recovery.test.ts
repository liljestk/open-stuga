import type { HouseWeather, WeatherComponentStatuses } from "@climate-twin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimateDatabase, outdoorLocationKey } from "../src/db.js";
import { WeatherRecoveryCoordinator } from "../src/weather-recovery.js";
import type { WeatherProvider } from "../src/weather.js";

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
});
