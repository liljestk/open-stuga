import type { OutdoorTemperatureSample, WeatherProviderName } from "@climate-twin/contracts";
import { OutdoorTemperatureRow } from "../support/row-types.js";
import type { HistoricalTelemetryGap } from "../telemetry-gap-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { outdoorLocationKey } from "../support/outdoor-location.js";
import { outdoorTemperatureFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
    outdoorTemperatureGaps(houseId: string, locationKey: string, provider: WeatherProviderName, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    latestOutdoorTemperatureTimestamp(houseId: string, locationKey: string, provider: WeatherProviderName): string | null;
  }

  interface ClimateDatabaseCore {
    upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample, options?: { deferDerivedInvalidation?: boolean }): OutdoorTemperatureSample;
    outdoorTemperatureHistory(houseId: string, locationKey: string, from: string, to: string, limit?: number): OutdoorTemperatureSample[];
    outdoorTemperatureGaps(houseId: string, locationKey: string, provider: WeatherProviderName, from: string, to: string, minimumGapMs: number, limit?: number): HistoricalTelemetryGap[];
    latestOutdoorTemperatureTimestamp(houseId: string, locationKey: string, provider: WeatherProviderName): string | null;
  }
}

registerDatabaseMethods({
  upsertOutdoorTemperatureSample(
      sample: OutdoorTemperatureSample,
      options: { deferDerivedInvalidation?: boolean } = {},
    ): OutdoorTemperatureSample {
      if (![sample.temperatureC, Date.parse(sample.timestamp), Date.parse(sample.fetchedAt)].every(Number.isFinite)) {
        throw new ClimateDataValidationError(400, "INVALID_OUTDOOR_SAMPLE", "Outdoor temperature and timestamps must be finite");
      }
      if (!this.getHouse(sample.houseId)) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
      }
      return this.immediateTransaction(() => {
        if (sample.source === "mock" && this.isRealDataMode()) {
          throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Synthetic outdoor samples are permanently disabled in real-data mode");
        }
        if (sample.source !== "mock" && !this.isRealDataMode()) this.activateRealDataMode();
        this.db.prepare(`INSERT INTO outdoor_temperature_samples
          (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name, conditions_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(house_id, location_key, timestamp, source) DO UPDATE SET
            temperature_c = excluded.temperature_c,
            fetched_at = excluded.fetched_at,
            station_id = excluded.station_id,
            station_name = excluded.station_name,
            conditions_json = excluded.conditions_json`)
          .run(sample.houseId, sample.locationKey, sample.timestamp, sample.temperatureC, sample.source,
            sample.fetchedAt, sample.stationId, sample.stationName,
            sample.conditions ? JSON.stringify(sample.conditions) : null);
        if (!options.deferDerivedInvalidation) {
          this.invalidateDerivedAnalyticsHistory(sample.houseId, sample.timestamp, sample.timestamp);
        }
        return sample;
      });
    },
  /**
     * Persist a live boundary only while its opaque location key still matches
     * the house's current weather location. The check happens before the
     * irreversible real-data latch in `upsertOutdoorTemperatureSample`.
     */
  upsertCurrentOutdoorTemperatureSample(
      sample: OutdoorTemperatureSample,
      options: { deferDerivedInvalidation?: boolean } = {},
    ): OutdoorTemperatureSample {
      const house = this.getHouse(sample.houseId);
      if (!house) {
        throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
      }
      if (sample.locationKey !== outdoorLocationKey(house.location)) {
        throw new ClimateDataValidationError(
          409,
          "WEATHER_REQUEST_SUPERSEDED",
          "House location changed while weather was loading; the old-location observation was discarded",
        );
      }
      return this.upsertOutdoorTemperatureSample(sample, options);
    },
  outdoorTemperatureHistory(
      houseId: string,
      locationKey: string,
      from: string,
      to: string,
      limit = 20_000,
    ): OutdoorTemperatureSample[] {
      if (!this.getHouse(houseId)) return [];
      const rows = this.db.prepare(`SELECT house_id, location_key, timestamp, temperature_c, source, fetched_at,
        station_id, station_name, conditions_json FROM (
          SELECT rowid, house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name,
            conditions_json
          FROM outdoor_temperature_samples
          WHERE house_id = ? AND location_key = ? AND timestamp >= ? AND timestamp <= ?
          ORDER BY timestamp DESC, rowid DESC LIMIT ?
        ) ORDER BY timestamp ASC, rowid ASC`)
        .all(houseId, locationKey, from, to, limit) as unknown as OutdoorTemperatureRow[];
      return rows.map(outdoorTemperatureFromRow);
    },
  outdoorTemperatureGaps(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
      from: string,
      to: string,
      minimumGapMs: number,
      limit = 100,
    ): HistoricalTelemetryGap[] {
      if (!this.getHouse(houseId)) return [];
      const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
      const thresholdSeconds = Math.max(1, minimumGapMs / 1_000);
      const sourcePrefix = provider === "fmi" ? "fmi-%" : "open-meteo-%";
      const rows = this.db.prepare(`WITH sample_times AS (
          SELECT DISTINCT timestamp FROM outdoor_temperature_samples
          WHERE house_id = ? AND location_key = ? AND source LIKE ?
            AND timestamp >= ? AND timestamp <= ?
        ), ordered AS (
          SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS previous_timestamp
          FROM sample_times
        )
        SELECT previous_timestamp AS started_at, timestamp AS ended_at,
          (julianday(timestamp) - julianday(previous_timestamp)) * 86400000.0 AS duration_ms
        FROM ordered
        WHERE previous_timestamp IS NOT NULL
          AND (julianday(timestamp) - julianday(previous_timestamp)) * 86400.0 >= ?
        ORDER BY previous_timestamp LIMIT ?`)
        .all(houseId, locationKey, sourcePrefix, from, to, thresholdSeconds, safeLimit) as unknown as Array<{
          started_at: string;
          ended_at: string;
          duration_ms: number;
        }>;
      return rows.map((row) => ({
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: Math.max(0, Math.round(row.duration_ms)),
      }));
    },
  latestOutdoorTemperatureTimestamp(
      houseId: string,
      locationKey: string,
      provider: WeatherProviderName,
    ): string | null {
      if (!this.getHouse(houseId)) return null;
      const sourcePrefix = provider === "fmi" ? "fmi-%" : "open-meteo-%";
      const row = this.db.prepare(`SELECT timestamp FROM outdoor_temperature_samples
        WHERE house_id = ? AND location_key = ? AND source LIKE ?
        ORDER BY timestamp DESC LIMIT 1`)
        .get(houseId, locationKey, sourcePrefix) as { timestamp?: string } | undefined;
      return row?.timestamp ?? null;
    },
});
