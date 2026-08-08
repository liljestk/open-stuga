import { describe, expect, it } from "vitest";
import type { HouseWeather } from "@climate-twin/contracts";
import { ClimateDatabase, outdoorLocationKey } from "../src/db.js";
import { TelemetryBus } from "../src/events.js";
import { WEATHER_SNAPSHOT_SCHEMA_SQL } from "../src/db/migrations/weather-snapshot-schema.js";
import { RuntimeStatus } from "../src/services.js";
import { config } from "./weatherTestSupport.js";

function snapshot(latitude = 60.1699, longitude = 24.9384): HouseWeather {
  return {
    houseId: "house-main",
    location: { latitude, longitude },
    provider: "fmi",
    attribution: "Test weather",
    fetchedAt: "2026-08-08T08:00:00.000Z",
    forecastIssuedAt: "2026-08-08T07:00:00.000Z",
    stale: false,
    current: { timestamp: "2026-08-08T07:50:00.000Z", temperatureC: 18 },
    observationStation: null,
    forecast: [{ timestamp: "2026-08-08T09:00:00.000Z", temperatureC: 19 }],
    warnings: [],
    unavailable: [],
  };
}

describe("durable weather snapshots", () => {
  it("installs idempotently and preserves same-location last-good data on failure", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      database.db.exec(WEATHER_SNAPSHOT_SCHEMA_SQL);
      database.db.exec(WEATHER_SNAPSHOT_SCHEMA_SQL);
      const weather = snapshot();
      weather.forecast.push({ timestamp: "2026-08-10T09:00:01.000Z", temperatureC: 25 });
      const key = outdoorLocationKey(weather.location);

      database.saveWeatherSnapshot(weather, key, "2026-08-08T08:00:01.000Z");
      const failed = database.noteWeatherSnapshotFailure(
        weather.houseId,
        key,
        new Error("provider offline"),
        "2026-08-08T08:15:00.000Z",
      );

      expect(failed).toMatchObject({
        houseId: weather.houseId,
        locationKey: key,
        lastAttemptAt: "2026-08-08T08:15:00.000Z",
        lastSuccessAt: weather.fetchedAt,
        lastError: "provider offline",
        weather: { houseId: weather.houseId, stale: false },
      });
      expect(failed.weather?.forecast.map((point) => point.timestamp))
        .toEqual(["2026-08-08T09:00:00.000Z"]);
      expect((database.db.prepare("SELECT COUNT(*) AS count FROM weather_snapshots").get() as { count: number }).count)
        .toBe(1);
    } finally {
      database.close();
    }
  });

  it("never serves a last-good snapshot after the Home moves", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const weather = snapshot();
      const previousKey = outdoorLocationKey(weather.location);
      const nextLocation = { latitude: 35.6762, longitude: 139.6503 };
      const nextKey = outdoorLocationKey(nextLocation);
      database.saveWeatherSnapshot(weather, previousKey, "2026-08-08T08:00:01.000Z");

      const moved = database.noteWeatherSnapshotFailure(
        weather.houseId,
        nextKey,
        "new location unavailable",
        "2026-08-08T08:15:00.000Z",
      );

      expect(moved).toMatchObject({ locationKey: nextKey, weather: null, lastSuccessAt: null });
      expect(database.getWeatherSnapshot(weather.houseId, previousKey)).toBeNull();
    } finally {
      database.close();
    }
  });

  it("hydrates integration status from the durable snapshot after process restart", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const weather = snapshot();
      database.updateHouse(weather.houseId, { location: weather.location });
      database.saveWeatherSnapshot(weather, outdoorLocationKey(weather.location), "2026-08-08T08:00:01.000Z");

      const status = new RuntimeStatus(config, new TelemetryBus(), database);

      expect(status.value.weather).toMatchObject({
        provider: "fmi",
        lastSuccessAt: weather.fetchedAt,
        error: null,
        connections: [expect.objectContaining({
          houseId: weather.houseId,
          lastSuccessAt: weather.fetchedAt,
          error: null,
        })],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["malformed JSON", "{"],
    ["a valid JSON value with the wrong shape", JSON.stringify({ forecast: [] })],
  ])("degrades instead of failing startup for %s", (_name, persisted) => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      const weather = snapshot();
      const locationKey = outdoorLocationKey(weather.location);
      database.updateHouse(weather.houseId, { location: weather.location });
      database.saveWeatherSnapshot(weather, locationKey, "2026-08-08T08:00:01.000Z");
      database.db.exec("PRAGMA ignore_check_constraints = ON");
      database.db.prepare("UPDATE weather_snapshots SET weather_json = ? WHERE house_id = ?")
        .run(persisted, weather.houseId);

      expect(() => database.getWeatherSnapshot(weather.houseId, locationKey)).not.toThrow();
      expect(database.getWeatherSnapshot(weather.houseId, locationKey)).toMatchObject({
        weather: null,
        lastError: expect.stringContaining("stored weather snapshot is invalid"),
      });
      expect(() => new RuntimeStatus(config, new TelemetryBus(), database)).not.toThrow();
      expect(new RuntimeStatus(config, new TelemetryBus(), database).value.weather)
        .toMatchObject({ error: expect.stringContaining("stored weather snapshot is invalid") });
    } finally {
      database.close();
    }
  });

  it("keeps a pre-migration read-only consumer local when the snapshot table is absent", () => {
    const database = new ClimateDatabase(":memory:", true);
    try {
      database.db.exec("DROP TABLE weather_snapshots");
      expect(database.getWeatherSnapshot("house-main", "geo:missing")).toBeNull();
    } finally {
      database.close();
    }
  });
});
