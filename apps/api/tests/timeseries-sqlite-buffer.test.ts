import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClimateDatabase } from "../src/db.js";

describe("SQLite telemetry archive buffer", () => {
  let database: ClimateDatabase;
  let sensorId: string;

  beforeEach(() => {
    database = new ClimateDatabase(":memory:");
    sensorId = database.listSensors()[0]!.id;
  });

  afterEach(() => database.close());

  it("uses explicit monotonic IDs for rowid-less archive tables across delete and VACUUM", () => {
    database.upsertOutdoorTemperatureSample({
      houseId: "house-main",
      locationKey: "archive-location",
      timestamp: "2024-01-01T00:00:00.000Z",
      temperatureC: -2,
      source: "api",
      fetchedAt: "2024-01-01T00:01:00.000Z",
      stationId: null,
      stationName: null,
    });
    database.storePropertyElectricityPrices("property-main", [{
      startAt: "2024-01-01T00:00:00.000Z",
      endAt: "2024-01-01T01:00:00.000Z",
      rawPriceCentsPerKwh: 5,
    }], "2024-01-01T00:01:00.000Z");

    const firstOutdoor = database.outdoorTemperatureArchivePage(0, 10_000)
      .find(({ record }) => record.locationKey === "archive-location")!;
    const firstPrice = database.electricityPriceArchivePage(0, 10_000)
      .find(({ record }) => record.startAt === "2024-01-01T00:00:00.000Z")!;
    database.db.prepare(`DELETE FROM outdoor_temperature_samples
      WHERE house_id = ? AND location_key = ? AND timestamp = ? AND source = ?`)
      .run("house-main", "archive-location", "2024-01-01T00:00:00.000Z", "api");
    database.db.prepare("DELETE FROM electricity_price_points WHERE property_id = ? AND start_at = ?")
      .run("property-main", "2024-01-01T00:00:00.000Z");
    database.db.exec("VACUUM");

    database.upsertOutdoorTemperatureSample({
      houseId: "house-main",
      locationKey: "archive-location",
      timestamp: "2024-01-01T02:00:00.000Z",
      temperatureC: -1,
      source: "api",
      fetchedAt: "2024-01-01T02:01:00.000Z",
      stationId: null,
      stationName: null,
    });
    database.storePropertyElectricityPrices("property-main", [{
      startAt: "2024-01-01T02:00:00.000Z",
      endAt: "2024-01-01T03:00:00.000Z",
      rawPriceCentsPerKwh: 6,
    }], "2024-01-01T02:01:00.000Z");

    const nextOutdoor = database.outdoorTemperatureArchivePage(firstOutdoor.rowId, 10).at(0)!;
    const nextPrice = database.electricityPriceArchivePage(firstPrice.rowId, 10).at(0)!;
    expect(nextOutdoor.rowId).toBeGreaterThan(firstOutdoor.rowId);
    expect(nextOutdoor.record.timestamp).toBe("2024-01-01T02:00:00.000Z");
    expect(nextPrice.rowId).toBeGreaterThan(firstPrice.rowId);
    expect(nextPrice.record.startAt).toBe("2024-01-01T02:00:00.000Z");
  });

  it("rewinds legacy implicit-rowid cursors exactly once during the explicit-ID upgrade", () => {
    const directory = mkdtempSync(join(tmpdir(), "stuga-archive-cursor-"));
    const path = join(directory, "upgrade.sqlite");
    let upgraded: ClimateDatabase | null = null;
    try {
      const legacy = new ClimateDatabase(path);
      legacy.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run("telemetry_archive_checkpoint:measurement_samples", "77");
      for (const table of ["outdoor_temperature_samples", "electricity_price_samples"]) {
        legacy.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(`telemetry_archive_checkpoint:${table}`, "99");
      }
      legacy.db.prepare("DELETE FROM metadata WHERE key = 'telemetry_archive_cursor_format'").run();
      legacy.close();

      upgraded = new ClimateDatabase(path, false);
      expect(upgraded.telemetryArchiveCheckpoint("measurement_samples")).toBe(77);
      expect(upgraded.telemetryArchiveCheckpoint("outdoor_temperature_samples")).toBe(0);
      expect(upgraded.telemetryArchiveCheckpoint("electricity_price_samples")).toBe(0);
      expect((upgraded.db.prepare("SELECT value FROM metadata WHERE key = 'telemetry_archive_cursor_format'")
        .get() as { value: string }).value).toBe("explicit-archive-id-v1");

      upgraded.saveTelemetryArchiveCheckpoint("outdoor_temperature_samples", 12);
      upgraded.migrate();
      expect(upgraded.telemetryArchiveCheckpoint("outdoor_temperature_samples")).toBe(12);
    } finally {
      upgraded?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps mutable rows dirty until the exact observed version is acknowledged", () => {
    const reading = {
      sensorId,
      timestamp: "2024-02-01T00:00:00.000Z",
      temperature: 20,
      humidity: 40,
      battery: 90,
      source: "api" as const,
      quality: "good" as const,
    };
    database.upsertLegacyReading(reading);
    database.upsertLegacyReading({ ...reading, temperature: 21 });
    const first = database.readingArchiveDirtyPage(10).at(0)!;
    expect(first.record.temperature).toBe(21);

    database.upsertLegacyReading({ ...reading, temperature: 22 });
    const second = database.readingArchiveDirtyPage(10).at(0)!;
    expect(second.dirtyId).toBe(first.dirtyId);
    expect(second.version).toBeGreaterThan(first.version);
    expect(database.acknowledgeTelemetryArchiveDirtyRows("legacy_readings", [{
      dirtyId: first.dirtyId,
      version: first.version,
    }])).toBe(0);
    expect(database.readingArchiveDirtyPage(10).at(0)?.record.temperature).toBe(22);
    expect(database.acknowledgeTelemetryArchiveDirtyRows("legacy_readings", [{
      dirtyId: second.dirtyId,
      version: second.version,
    }])).toBe(1);
    expect(database.readingArchiveDirtyPage(10)).toEqual([]);
  });

  it("changes the stable-pass token when one dirty identity replaces another at the same version", () => {
    const first = {
      sensorId,
      timestamp: "2024-02-02T00:00:00.000Z",
      temperature: 20,
      humidity: 40,
      battery: 90,
      source: "api" as const,
      quality: "good" as const,
    };
    database.upsertLegacyReading(first);
    database.upsertLegacyReading({ ...first, temperature: 21 });
    const dirty = database.readingArchiveDirtyPage(10).at(0)!;
    const before = database.telemetryArchiveStateToken();
    database.acknowledgeTelemetryArchiveDirtyRows("legacy_readings", [{
      dirtyId: dirty.dirtyId,
      version: dirty.version,
    }]);
    const second = { ...first, timestamp: "2024-02-02T01:00:00.000Z" };
    database.upsertLegacyReading(second);
    database.upsertLegacyReading({ ...second, temperature: 22 });

    expect(database.readingArchiveDirtyPage(10).at(0)?.version).toBe(dirty.version);
    expect(database.telemetryArchiveStateToken()).not.toBe(before);
  });

  it("retains complete outdoor observation metadata on the initial archive page", () => {
    const timestamp = "2024-02-03T00:00:00.000Z";
    const conditions = {
      timestamp,
      temperatureC: -7.5,
      dewPointC: -9.2,
      relativeHumidityPercent: 86,
      windDirectionDegrees: 315,
      windSpeedMps: 4.2,
      windGustMps: 7.8,
      precipitation1hMm: 0,
      cloudCoverPercent: 73,
      visibilityMeters: 18_500,
      weatherSymbolCode: 4,
    };
    database.upsertOutdoorTemperatureSample({
      houseId: "house-main",
      locationKey: "metadata-initial-location",
      timestamp,
      temperatureC: -7.5,
      source: "api",
      fetchedAt: "2024-02-03T00:01:00.000Z",
      stationId: "station-initial",
      stationName: "Initial station",
      conditions,
    });

    const archived = database.outdoorTemperatureArchivePage(0, 10_000)
      .find(({ record }) => record.locationKey === "metadata-initial-location")!;
    expect(archived.record.conditions).toStrictEqual(conditions);
  });

  it("retains complete outdoor observation metadata on dirty-row updates", () => {
    const timestamp = "2024-02-04T00:00:00.000Z";
    const initialConditions = {
      timestamp,
      temperatureC: 1,
      relativeHumidityPercent: 78,
      windSpeedMps: 2,
      precipitation1hMm: 0,
    };
    const updatedConditions = {
      timestamp,
      temperatureC: 1.5,
      dewPointC: -1.2,
      relativeHumidityPercent: 81,
      pressureHpa: 1_006.4,
      windDirectionDegrees: 225,
      windSpeedMps: 3.6,
      windGustMps: 6.1,
      precipitation1hMm: 0.4,
      precipitationFormCode: 2,
      snowDepthCm: 12,
      lowCloudCoverPercent: 91,
      visibilityMeters: 7_200,
      presentWeatherCode: 61,
    };
    const base = {
      houseId: "house-main",
      locationKey: "metadata-dirty-location",
      timestamp,
      temperatureC: 1,
      source: "api" as const,
      fetchedAt: "2024-02-04T00:01:00.000Z",
      stationId: "station-dirty",
      stationName: "Dirty station",
      conditions: initialConditions,
    };
    database.upsertOutdoorTemperatureSample(base);
    database.upsertOutdoorTemperatureSample({
      ...base,
      temperatureC: 1.5,
      fetchedAt: "2024-02-04T00:02:00.000Z",
      conditions: updatedConditions,
    });

    const dirty = database.outdoorTemperatureArchiveDirtyPage(10)
      .find(({ record }) => record.locationKey === "metadata-dirty-location")!;
    expect(dirty.record.conditions).toStrictEqual(updatedConditions);
    expect(dirty.record.conditions).not.toEqual(initialConditions);
  });

  it("never prunes rows newer than the durable archive watermarks", () => {
    const timestamps = ["2024-03-01T00:00:00.000Z", "2024-03-01T01:00:00.000Z"];
    for (const [index, timestamp] of timestamps.entries()) {
      database.insertReadings([{
        sensorId,
        timestamp,
        temperature: 20 + index,
        humidity: 40 + index,
        battery: 90,
        source: "api",
        quality: "good",
      }]);
      database.upsertOutdoorTemperatureSample({
        houseId: "house-main",
        locationKey: "retention-location",
        timestamp,
        temperatureC: index,
        source: "api",
        fetchedAt: timestamp,
        stationId: null,
        stationName: null,
      });
    }
    const measurementRows = database.measurementArchivePage(0, 10_000)
      .filter(({ record }) => record.sensorId === sensorId && record.timestamp === timestamps[0]);
    const readingRow = database.readingArchivePage(0, 10_000)
      .find(({ record }) => record.sensorId === sensorId && record.timestamp === timestamps[0])!;
    const outdoorRow = database.outdoorTemperatureArchivePage(0, 10_000)
      .find(({ record }) => record.locationKey === "retention-location" && record.timestamp === timestamps[0])!;

    database.purgeReadingsBefore("2025-01-01T00:00:00.000Z", 100, {
      measurement_samples: Math.max(...measurementRows.map(({ rowId }) => rowId)),
      legacy_readings: readingRow.rowId,
      outdoor_temperature_samples: outdoorRow.rowId,
    });

    expect(database.history([sensorId], "2024-03-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z")).toEqual([]);
    expect(database.history([sensorId], "2024-03-01T01:00:00.000Z", "2024-03-01T01:00:00.000Z")).toHaveLength(1);
    expect(database.outdoorTemperatureHistory(
      "house-main", "retention-location", timestamps[0], timestamps[0],
    )).toEqual([]);
    expect(database.outdoorTemperatureHistory(
      "house-main", "retention-location", timestamps[1], timestamps[1],
    )).toHaveLength(1);
  });
});
