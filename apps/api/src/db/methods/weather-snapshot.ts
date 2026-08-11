import { Buffer } from "node:buffer";
import type { HouseWeather } from "@climate-twin/contracts";
import { registerDatabaseMethods } from "../core.js";
import {
  CANONICAL_WEATHER_HOURS,
  MAX_WEATHER_SNAPSHOT_BYTES,
  canonicalWeatherSnapshot,
  storedWeatherSnapshotFromRow,
  weatherSnapshotError,
  type StoredWeatherSnapshot,
  type WeatherSnapshotRow,
} from "../weather-snapshot-types.js";

function rowFor(
  database: { prepare(sql: string): { get(...parameters: unknown[]): unknown } },
  houseId: string,
  locationKey: string,
): StoredWeatherSnapshot | null {
  try {
    const row = database.prepare(`SELECT house_id, location_key, weather_json,
        last_attempt_at, last_success_at, last_error, updated_at
      FROM weather_snapshots WHERE house_id = ? AND location_key = ?`)
      .get(houseId, locationKey) as WeatherSnapshotRow | undefined;
    return row ? storedWeatherSnapshotFromRow(row) : null;
  } catch (error) {
    // A read-only MCP process may briefly open a pre-migration database while
    // the API is still being upgraded. It must stay local-only, not fall back
    // to an upstream request merely because the snapshot table is absent.
    if (error instanceof Error && error.message.includes("no such table: weather_snapshots")) return null;
    throw error;
  }
}

registerDatabaseMethods({
  getWeatherSnapshot(houseId: string, locationKey: string): StoredWeatherSnapshot | null {
    return rowFor(this.db, houseId, locationKey);
  },

  saveWeatherSnapshot(
    weather: HouseWeather,
    locationKey: string,
    attemptedAt = new Date().toISOString(),
  ): StoredWeatherSnapshot {
    const canonical = canonicalWeatherSnapshot(weather);
    const serialized = JSON.stringify(canonical);
    if (Buffer.byteLength(serialized, "utf8") > MAX_WEATHER_SNAPSHOT_BYTES) {
      throw new RangeError("Canonical weather snapshot exceeds the 2 MiB storage limit");
    }
    this.db.prepare(`INSERT INTO weather_snapshots (
        house_id, location_key, horizon_hours, weather_json,
        last_attempt_at, last_success_at, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(house_id) DO UPDATE SET
        location_key = excluded.location_key,
        horizon_hours = excluded.horizon_hours,
        weather_json = excluded.weather_json,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        last_error = NULL,
        updated_at = excluded.updated_at`)
      .run(
        weather.houseId,
        locationKey,
        CANONICAL_WEATHER_HOURS,
        serialized,
        attemptedAt,
        weather.fetchedAt,
        attemptedAt,
      );
    return rowFor(this.db, weather.houseId, locationKey) as StoredWeatherSnapshot;
  },

  noteWeatherSnapshotFailure(
    houseId: string,
    locationKey: string,
    error: unknown,
    attemptedAt = new Date().toISOString(),
  ): StoredWeatherSnapshot {
    this.db.prepare(`INSERT INTO weather_snapshots (
        house_id, location_key, horizon_hours, weather_json,
        last_attempt_at, last_success_at, last_error, updated_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)
      ON CONFLICT(house_id) DO UPDATE SET
        location_key = excluded.location_key,
        horizon_hours = excluded.horizon_hours,
        weather_json = CASE
          WHEN weather_snapshots.location_key = excluded.location_key
            THEN weather_snapshots.weather_json
          ELSE NULL
        END,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = CASE
          WHEN weather_snapshots.location_key = excluded.location_key
            THEN weather_snapshots.last_success_at
          ELSE NULL
        END,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`)
      .run(
        houseId,
        locationKey,
        CANONICAL_WEATHER_HOURS,
        attemptedAt,
        weatherSnapshotError(error),
        attemptedAt,
      );
    return rowFor(this.db, houseId, locationKey) as StoredWeatherSnapshot;
  },
});
